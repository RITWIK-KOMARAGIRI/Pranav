require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const { SerialPort } = require('serialport');

const app = express();
app.use(express.json());

// ---------- DB ----------
const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || 'meterdb',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD,
  max: 10,
};
let pool = null;

async function saveReading(r) {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO meter_readings (slave_id, register_address, raw_value, decoded_value, status)
       VALUES ($1, $2, $3, $4, $5)`,
      [r.slaveId, r.address, r.raw || null, r.value ?? null, r.status]
    );
  } catch (e) {
    console.error('DB save failed:', e.message);
  }
}

// ---------- Modbus RTU ----------
function crc16(buf) {
  let crc = 0xFFFF;
  for (const b of buf) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = (crc & 1) ? (crc >> 1) ^ 0xA001 : crc >> 1;
  }
  return crc;
}

function buildRequest(slave, fc, addr, qty) {
  const b = Buffer.alloc(8);
  b.writeUInt8(slave, 0);
  b.writeUInt8(fc, 1);
  b.writeUInt16BE(addr, 2);
  b.writeUInt16BE(qty, 4);
  b.writeUInt16LE(crc16(b.subarray(0, 6)), 6);
  return b;
}

function expectedLength(buf) {
  if (buf.length < 2) return null;
  if (buf[1] & 0x80) return 5;          // exception frame
  if (buf.length < 3) return null;
  return 3 + buf[2] + 2;                // slave+fc+bytecount + data + crc
}

function mbError(status, message) {
  return Object.assign(new Error(message), { status });
}

// One open port per COM path; reopened if baud/parity change
const ports = new Map(); // path -> { baud, parity, promise }
function getPort(path, baud, parity) {
  const cur = ports.get(path);
  if (cur && cur.baud === baud && cur.parity === parity) return cur.promise;

  const promise = (async () => {
    if (cur) {
      const old = await cur.promise.catch(() => null);
      if (old && old.isOpen) await new Promise((r) => old.close(r));
    }
    return new Promise((resolve, reject) => {
      const sp = new SerialPort({ path, baudRate: baud, dataBits: 8, parity, stopBits: 1, autoOpen: false });
      sp.on('error', (e) => console.error('Serial error:', e.message));
      sp.on('close', () => { if (ports.get(path)?.promise === promise) ports.delete(path); });
      sp.open((err) => (err ? reject(err) : resolve(sp)));
    });
  })();

  const entry = { baud, parity, promise };
  ports.set(path, entry);
  promise.catch(() => { if (ports.get(path) === entry) ports.delete(path); });
  return promise;
}

async function transact(path, baud, parity, request, timeoutMs) {
  let sp;
  try { sp = await getPort(path, baud, parity); }
  catch (e) { throw mbError('CONN_ERROR', e.message); }

  return new Promise((resolve, reject) => {
    let rx = Buffer.alloc(0);
    let finished = false;
    let echoChecked = false;
    const timer = setTimeout(() => done(mbError('TIMEOUT', 'Timeout')), timeoutMs);

    const onData = (chunk) => {
      rx = Buffer.concat([rx, chunk]);

      // Strip echo of our own request (some RS-485 converters echo TX bytes)
      if (!echoChecked) {
        if (rx.length < request.length) {
          if (request.subarray(0, rx.length).equals(rx)) return; // maybe partial echo, wait
          echoChecked = true;
        } else {
          echoChecked = true;
          if (rx.subarray(0, request.length).equals(request)) rx = rx.subarray(request.length);
        }
      }

      const len = expectedLength(rx);
      if (len !== null && rx.length >= len) done(null, rx.subarray(0, len));
    };

    const done = (err, frame) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      sp.off('data', onData);
      setTimeout(() => (err ? reject(err) : resolve(frame)), 30); // line turnaround gap
    };

    sp.on('data', onData);
    sp.flush(() => sp.write(request, (err) => {
      if (err) done(mbError('CONN_ERROR', err.message));
    }));
  });
}

function parseResponse(frame, slave, fc, qty) {
  const len = frame.length;
  if (crc16(frame.subarray(0, len - 2)) !== frame.readUInt16LE(len - 2))
    throw mbError('CRC_ERROR', 'CRC mismatch');
  if (frame[0] !== slave) throw mbError('BAD_RESPONSE', 'Wrong slave ID');
  if (frame[1] & 0x80) throw mbError('EXCEPTION', 'Modbus exception code ' + frame[2]);
  if (frame[1] !== fc) throw mbError('BAD_RESPONSE', 'Wrong function code');
  if (frame[2] !== qty * 2) throw mbError('BAD_RESPONSE', 'Unexpected byte count');
  return frame.subarray(3, 3 + frame[2]);
}

// wordOrder: 'ABCD' = high word first, 'CDAB' = low word first
function decode(data, type, wordOrder) {
  if (type === 'ascii') return data.toString('ascii').replace(/\0/g, '').trim();
  if (type === 'uint16') return data.readUInt16BE(0);
  if (type === 'int16') return data.readInt16BE(0);
  let b = Buffer.from(data.subarray(0, 4));
  if (wordOrder === 'CDAB') b = Buffer.from([b[2], b[3], b[0], b[1]]);
  if (type === 'uint32') return b.readUInt32BE(0);
  if (type === 'int32') return b.readInt32BE(0);
  if (type === 'float32') return b.readFloatBE(0);
  throw new Error('Unknown dataType ' + type);
}

// One request at a time per serial line
const queues = new Map();
function enqueue(key, task) {
  const next = (queues.get(key) || Promise.resolve()).catch(() => {}).then(task);
  queues.set(key, next);
  return next;
}

async function readWithRetry(p) {
  const req = buildRequest(p.slaveId, p.functionCode, p.address, p.quantity);
  let lastErr;
  for (let attempt = 0; attempt <= p.retries; attempt++) {
    try {
      const frame = await transact(p.path, p.baud, p.parity, req, p.timeoutMs);
      return parseResponse(frame, p.slaveId, p.functionCode, p.quantity);
    } catch (e) {
      lastErr = e;
      if (e.status === 'EXCEPTION') break; // meter answered, retrying won't help
    }
  }
  throw lastErr;
}

// ---------- API ----------
app.get('/api/ports', async (req, res) => {
  try {
    const list = await SerialPort.list();
    const ports = list
      .map((p) => ({
        path: p.path,
        name: p.friendlyName || p.manufacturer || p.path,
        manufacturer: p.manufacturer || null,
        isUsb: !!p.vendorId,
        isBluetooth: /BTHENUM/i.test(p.pnpId || '') || /bluetooth/i.test(p.friendlyName || ''),
      }))
      .sort((a, b) => (parseInt(a.path.replace(/\D/g, '')) || 0) - (parseInt(b.path.replace(/\D/g, '')) || 0));
    res.json(req.query.all === '1' ? ports : ports.filter((p) => !p.isBluetooth));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/read', async (req, res) => {
  const b = req.body || {};
  const p = {
    path: b.path,                         // 'COM14'
    baud: Number(b.baud ?? 9600),
    parity: b.parity || 'none',           // none / even / odd
    slaveId: Number(b.slaveId),
    functionCode: Number(b.functionCode ?? 3),
    address: Number(b.address),
    quantity: Number(b.quantity ?? 1),
    dataType: b.dataType || 'uint16',
    wordOrder: b.wordOrder || 'ABCD',
    scale: Number(b.scale ?? 1),
    retries: Number(b.retries ?? 2),
    timeoutMs: Number(b.timeoutMs ?? 2000),
  };

  const regsNeeded = { uint16: 1, int16: 1, uint32: 2, int32: 2, float32: 2, ascii: 1 , hex: 1}[p.dataType];

  if (!p.path || !(p.slaveId >= 1 && p.slaveId <= 247) || !Number.isInteger(p.address) ||
      !(p.quantity >= 1 && p.quantity <= 125) || ![3, 4].includes(p.functionCode) ||
      !['none', 'even', 'odd'].includes(p.parity) ||
      !regsNeeded || p.quantity < regsNeeded)
    return res.status(400).json({ error: 'Invalid parameters (check path, functionCode 3/4, parity, quantity vs dataType)' });

  try {
    const data = await enqueue(p.path, () => readWithRetry(p));
        if (p.dataType === 'hex') {
      const req = buildRequest(p.slaveId, p.functionCode, p.address, p.quantity);
      const fmt = (b) => b.toString('hex').toUpperCase().match(/../g).join(' ');
      const resp = Buffer.concat([Buffer.from([p.slaveId, p.functionCode, data.length]), data]);
      const crc = Buffer.alloc(2);
      crc.writeUInt16LE(crc16(resp), 0);

      const values = [];
      for (let o = 0; o + 4 <= data.length; o += 4) {
        const g = data.subarray(o, o + 4);
        const swapped = Buffer.from([g[2], g[3], g[0], g[1]]);
        values.push({
          address: p.address + o / 2,        // first register of this 4-byte group
          hex: fmt(g),
          uint32: g.readUInt32BE(0),
          int32: g.readInt32BE(0),
          uint32_swapped: swapped.readUInt32BE(0),   // word order CDAB
          int32_swapped: swapped.readInt32BE(0),
        });
      }

      const leftover = data.length % 4 ? fmt(data.subarray(data.length - (data.length % 4))) : null;

      await saveReading({ slaveId: p.slaveId, address: p.address, raw: data, value: null, status: 'OK' });
      return res.json({
        status: 'OK',
        tx: fmt(req),
        rx: fmt(Buffer.concat([resp, crc])),
        values,
        leftoverBytes: leftover,
      });
    }
    const decoded = decode(data, p.dataType, p.wordOrder);
    const value = typeof decoded === 'string' ? decoded : decoded * p.scale;
    const n = Number(value);
    const dbValue = value !== '' && Number.isFinite(n) ? n : null; // DB column is numeric; raw bytes are stored too

    await saveReading({ slaveId: p.slaveId, address: p.address, raw: data, value: dbValue, status: 'OK' });
    res.json({ status: 'OK', slaveId: p.slaveId, address: p.address, rawHex: data.toString('hex'), value });
  } catch (e) {
    const status = e.status || 'ERROR';
    await saveReading({ slaveId: p.slaveId, address: p.address, status });
    res.status(502).json({ status, error: e.message });
  }
});
// ---------- Register map groups ----------
const GROUPS = {
  cumulative: {
    table: 'meter_cumulative_energy', start: 37, quantity: 24, wordOrder: 'ABCD',
    params: [[37,'Active(I) Total Wh'],[41,'Active(E) Total Wh'],[45,'Active(I) Fund Wh'],[49,'Active(E) Fund Wh'],
      [53,'Reactive(I) Active(I) Varh'],[57,'Reactive(I) Active(E) Varh'],[61,'Reactive(E) Active(E) Varh'],
      [65,'Reactive(E) Active(I) Varh'],[69,'Apparent(I) VAh'],[73,'Apparent(E) VAh'],
      [77,'Abs Active Total Wh'],[81,'Abs Apparent VAh']],
  },
  instantaneous: {
    table: 'meter_instantaneous', start: 85, quantity: 28, wordOrder: 'ABCD',
    params: [[85,'Current L1'],[89,'Current L2'],[93,'Current L3'],[97,'Total Active Power'],
      [101,'Total Reactive Power'],[105,'Total Apparent Power'],[109,'Voltage L1'],[113,'Voltage L2'],
      [117,'Voltage L3'],[121,'Power factor L1'],[125,'Power factor L2'],[129,'Power factor L3'],
      [133,'Average Power factor'],[137,'Frequency']],
  },
};

const FIXED = { baud: 9600, parity: 'none', functionCode: 3, retries: 1, timeoutMs: 2000 };

app.post('/api/meters/poll', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'DB not connected' });
  const b = req.body || {};
  const base = { ...FIXED, path: b.path, slaveId: Number(b.slaveId) };
  const names = !b.group || b.group === 'all' ? Object.keys(GROUPS) : [b.group];
  if (!/^(COM\d+|\/dev\/tty\S+)$/i.test(base.path || '') ||
      !Number.isInteger(base.slaveId) || base.slaveId < 1 || base.slaveId > 247 ||
      names.some((n) => !GROUPS[n]))
    return res.status(400).json({ error: 'Send path, slaveId (1-247) and group (cumulative | instantaneous | all)' });

  const results = {};
  for (const name of names) {
    const g = GROUPS[name];
    results[name] = [];
    try {
      // one block read for the whole group
      const data = await enqueue(base.path, () =>
        readWithRetry({ ...base, address: g.start, quantity: g.quantity }));

      for (let i = 0; i < g.params.length; i++) {
        const [address, parameter] = g.params[i];
        const chunk = data.subarray(i * 4, i * 4 + 4);   // 4 bytes per parameter
        const value = decode(chunk, 'int32', g.wordOrder);
        await pool.query(
          `INSERT INTO ${g.table} (slave_id, start_address, parameter, value, updated_at)
           VALUES ($1, $2, $3, $4, now())
           ON CONFLICT (slave_id, start_address)
           DO UPDATE SET value = EXCLUDED.value, parameter = EXCLUDED.parameter, updated_at = now()`,
          [base.slaveId, address, parameter, value]
        );
        results[name].push({ address, parameter, hex: chunk.toString('hex').toUpperCase(), value });
      }
      await saveReading({ slaveId: base.slaveId, address: g.start, raw: data, value: null, status: 'OK' });
    } catch (e) {
      await saveReading({ slaveId: base.slaveId, address: g.start, status: e.status || 'ERROR' });
      results[name] = { status: e.status || 'ERROR', error: e.message };
    }
  }
  res.json({ slaveId: base.slaveId, results });
});

app.get('/api/meters/:slaveId/:group', async (req, res) => {
  const g = GROUPS[req.params.group];
  if (!pool || !g) return res.status(400).json({ error: 'DB not connected or unknown group' });
  try {
    const r = await pool.query(
      `SELECT start_address, parameter, value, updated_at FROM ${g.table}
       WHERE slave_id = $1 ORDER BY start_address`,
      [Number(req.params.slaveId)]
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get('/api/readings', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'DB not connected' });
  try {
    const slaveId = req.query.slaveId ? Number(req.query.slaveId) : null;
    const limit = Math.min(Number(req.query.limit || 20), 1000);
    const r = await pool.query(
      `SELECT id, slave_id, register_address, decoded_value, status, read_at
       FROM meter_readings
       WHERE ($1::smallint IS NULL OR slave_id = $1)
       ORDER BY id DESC
       LIMIT $2`,
      [slaveId, limit]
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

(async () => {
  try {
    const p = new Pool(dbConfig);
    await p.query('SELECT 1');
    pool = p;
    console.log('Postgres connected');
  } catch (e) {
    console.error('DB connection failed (continuing without DB):', e.message);
  }
  app.listen(3000, () => console.log('Server on http://localhost:3000'));
})();