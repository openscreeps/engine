/*
 * Named divergences that apply to every scenario. A difference is attributed to a divergence only if
 * its path matches one of `paths` and `accept` holds for its exact oracle/local values; a scenario whose
 * remaining differences are all attributed reports `divergent`, never `match`. Scenario-specific
 * divergences (with assertions over both sides' runs) are declared on the scenario.
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const globalDivergences = [
  {
    name: 'money-log-date-representation',
    kind: 'representation',
    reason:
      'engine processor/global-intents/market.js writes users.money/users.resources `date: new Date()`; the storage RPC ' +
      '(JSON) and LokiJS persist it as an ISO-8601 string, which the backend money-history API returns. The local world ' +
      'stores the same instant as epoch milliseconds (state.ts MoneyLogDoc/ResourceLogDoc `date: number`, read numerically ' +
      'by game calcMarketStats and server moneyHistory). Accepted only when both denote the same instant.',
    paths: [/^(usersMoney|usersResources)\.[\w-]+\.date$/],
    accept: (d) =>
      typeof d.oracle === 'string' &&
      ISO_DATE.test(d.oracle) &&
      typeof d.local === 'number' &&
      Date.parse(d.oracle) === d.local,
  },
];
