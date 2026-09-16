/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/test/**/*.spec.ts', '<rootDir>/src/**/*.spec.ts'],
  moduleNameMapper: {
    '^@tas/decimal$': '<rootDir>/../../packages/decimal/src/index.ts',
    '^@tas/contracts$': '<rootDir>/../../packages/contracts/src/index.ts',
    '^@tas/dynaforms-core$': '<rootDir>/../../packages/dynaforms-core/src/index.ts',
  },
  transform: {
    '^.+\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
};
