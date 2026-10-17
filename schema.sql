CREATE TABLE IF NOT EXISTS meter_readings (
    id               BIGSERIAL PRIMARY KEY,
    slave_id         SMALLINT NOT NULL,
    register_address INT NOT NULL,
    raw_value        BYTEA,
    decoded_value    DOUBLE PRECISION,
    status           VARCHAR(20) NOT NULL,
    read_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_meter_readings_slave_time ON meter_readings (slave_id, read_at DESC);

CREATE TABLE IF NOT EXISTS meter_cumulative_energy (
    slave_id      SMALLINT NOT NULL,
    start_address INT NOT NULL,
    parameter     VARCHAR(60) NOT NULL,
    value         DOUBLE PRECISION,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (slave_id, start_address)
);

CREATE TABLE IF NOT EXISTS meter_instantaneous (
    slave_id      SMALLINT NOT NULL,
    start_address INT NOT NULL,
    parameter     VARCHAR(60) NOT NULL,
    value         DOUBLE PRECISION,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (slave_id, start_address)
);