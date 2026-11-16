/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/index.ts',
  ],
  testTimeout: 30000,
  setupFiles: ['<rootDir>/src/__tests__/env.ts'],
  // Mongo NO se levanta aqui. En CI lo aporta el servicio nativo `mongodb:` del
  // workflow, que es estable y no descarga ningun binario. En local no hay
  // Mongo, y los tests que lo necesitan se marcan como OMITIDOS con it.skip:
  // se ven en el informe, a diferencia de cuando se contaban como_APROBADOS_
  // sin ejecutarse.
};
