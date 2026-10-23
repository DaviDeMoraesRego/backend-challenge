/** Boundary enforcement (ADR-01). Run with `bun run lint:boundaries`. */
module.exports = {
  forbidden: [
    {
      name: 'no-domain-outward',
      severity: 'error',
      comment:
        'domain may only import itself (and pure libs) — never application/infrastructure/modules/roles.',
      from: { path: '^src/contexts/wagering/domain' },
      to: {
        path: '^src/(contexts/wagering/(application|infrastructure)|modules|roles)',
      },
    },
    {
      name: 'no-application-framework',
      severity: 'error',
      comment:
        'application imports domain + its own ports only (no infrastructure, modules, roles).',
      from: { path: '^src/contexts/wagering/application' },
      to: { path: '^src/(contexts/wagering/infrastructure|modules|roles)' },
    },
    {
      name: 'no-framework-in-domain',
      severity: 'error',
      comment: 'Nest/MikroORM/AWS/pino/prom-client/jose are infrastructure only.',
      from: { path: '^src/contexts/wagering/(domain|application)' },
      to: {
        path: 'node_modules/(@nestjs|@mikro-orm|@aws-sdk|pino|prom-client|jose)',
      },
    },
    {
      name: 'persistence-does-not-import-http',
      severity: 'error',
      comment: 'persistence is unaware of the HTTP layer.',
      from: { path: '^src/contexts/wagering/infrastructure/persistence' },
      to: { path: '^src/contexts/wagering/infrastructure/(http|messaging)' },
    },
    {
      name: 'no-cycles',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
    reporterOptions: {
      dot: { collapsePattern: 'node_modules/(@[^/]+/[^/]+|[^/]+)' },
    },
  },
};
