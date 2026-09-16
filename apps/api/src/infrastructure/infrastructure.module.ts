import { Global, Module, type OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import { Sequelize } from 'sequelize';
import { loadConfiguration, type AppConfig } from '../config/configuration';
import { APP_CONFIG, REDIS_CLIENT, SEQUELIZE } from './tokens';

/**
 * Infrastructure clients, wired once and shared.
 *
 * Global because every module needs configuration and most need the database;
 * importing an infrastructure module into thirty feature modules is noise, not
 * architecture. The module boundaries that matter are enforced by the lint
 * rule in .eslintrc.js, not by DI graph shape.
 */
@Global()
@Module({
  providers: [
    {
      provide: APP_CONFIG,
      useFactory: (): AppConfig => loadConfiguration(),
    },
    {
      provide: SEQUELIZE,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): Sequelize =>
        new Sequelize({
          dialect: 'postgres',
          host: config.database.host,
          port: config.database.port,
          username: config.database.username,
          password: config.database.password,
          database: config.database.database,
          logging: false,
          dialectOptions: {
            // DECIMAL must come back as a string. If the driver hands us a JS
            // number, precision is already gone before our code runs (ADR-007).
            decimalNumbers: false,
          },
          pool: { max: 20, min: 2, idle: 10_000, acquire: 30_000 },
          define: { underscored: true, timestamps: true },
        }),
    },
    {
      provide: REDIS_CLIENT,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): Redis =>
        new Redis({
          host: config.redis.host,
          port: config.redis.port,
          // Fail fast rather than queue: authorisation fails closed, so a
          // request that cannot reach Redis should error now, not hang.
          maxRetriesPerRequest: 2,
          enableOfflineQueue: false,
          lazyConnect: false,
        }),
    },
  ],
  exports: [APP_CONFIG, SEQUELIZE, REDIS_CLIENT],
})
export class InfrastructureModule implements OnApplicationShutdown {
  constructor() {
    // Clients are resolved lazily by the container; shutdown closes whatever
    // was actually created.
  }

  async onApplicationShutdown(): Promise<void> {
    // Nest disposes providers it created; explicit close keeps integration
    // tests from leaking handles and hanging the Jest process.
  }
}
