import tseslint from 'typescript-eslint';

const frameworkImports = [
  '@nestjs/*',
  '@mikro-orm/*',
  '@aws-sdk/*',
  'pino',
  'prom-client',
  '**/infrastructure/**',
];

export default tseslint.config(
  {
    ignores: ['node_modules/**', 'dist/**', 'test/load/**', '.artifacts/**'],
  },
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': 'off',
    },
  },
  {
    // Domain must stay framework free (ADR-01).
    files: ['src/contexts/wagering/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...frameworkImports,
            '**/application/**',
            '**/modules/**',
            '**/roles/**',
          ],
        },
      ],
    },
  },
  {
    // Money must never use the `number` type (README §5 restrição 1).
    files: ['src/contexts/wagering/domain/money/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TSNumberKeyword',
          message:
            'number is forbidden for monetary values — use Money/Decimal (restrição 1).',
        },
      ],
    },
  },
  {
    // Application layer may depend on domain + its own ports only (ADR-01).
    files: ['src/contexts/wagering/application/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...frameworkImports,
            '**/modules/**',
            '**/roles/**',
          ],
        },
      ],
    },
  },
  {
    // Hot-path SQL must be parameterized ($1..$n) — template literal *estático* é o
    // formato normal; o que se proíbe é INTERPOLAÇÃO (`${...}`). Inclui
    // `query`/`queryOne`, que são os métodos usados pelos repositórios.
    files: ['src/contexts/wagering/infrastructure/persistence/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.property.name=/^(execute|raw|executeRaw|query|queryOne)$/] > TemplateLiteral[expressions.length>0]",
          message:
            'SQL must be a constant string with $1..$n parameters — no interpolation (plans/06 §1.2.5).',
        },
      ],
    },
  },
  {
    // Wiring não pode silenciar a tipagem (ordem de `inject` é o único contrato).
    files: ['src/modules/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
);
