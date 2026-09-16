'use strict';

/**
 * sequelize-cli database configuration.
 *
 * Plan reference: V2 section 27.3 -- migrations are forward-only and run as a
 * pre-deploy job. Flowable manages its own schema through Liquibase and is not
 * touched from here.
 */

require('dotenv').config();

/** @param {string} name @param {string} [fallback] */
function env(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Required environment variable ${name} is not set.`);
  }
  return value;
}

const base = {
  dialect: 'postgres',
  host: env('DB_HOST', 'localhost'),
  port: Number(env('DB_PORT', '5433')),
  username: env('DB_USER', 'tas'),
  password: env('DB_PASSWORD', 'tas_local_dev_only'),
  database: env('DB_NAME', 'tax_assessment'),
  // Migration bookkeeping lives in the platform schema, not public.
  migrationStorageTableSchema: 'platform',
  migrationStorageTableName: 'sequelize_meta',
  seederStorage: 'sequelize',
  seederStorageTableSchema: 'platform',
  seederStorageTableName: 'sequelize_seed_meta',
  dialectOptions: {
    // DECIMAL columns must come back as strings. If the driver hands us a JS
    // number we have lost precision before any of our code runs (ADR-007).
    decimalNumbers: false,
  },
};

module.exports = {
  development: { ...base, logging: console.log },
  test: { ...base, database: env('DB_NAME_TEST', 'tax_assessment_test'), logging: false },
  sit: { ...base, logging: false },
  uat: { ...base, logging: false },
  production: {
    ...base,
    logging: false,
    dialectOptions: {
      ...base.dialectOptions,
      ssl: { require: true, rejectUnauthorized: true },
    },
  },
};
