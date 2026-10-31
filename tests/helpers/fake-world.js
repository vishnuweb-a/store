/**
 * In-memory stand-ins for the Frontiva PayIn tests: a PostgREST subset over
 * named tables, a fake Frontiva portal, and traps that record any request to
 * Airpay, SabPaisa or KKChat. Nothing here reaches the network.
 */

function splitTop(text) {
  const parts = [];
  let depth = 0;
  let start = 0;

  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    if (text[i] === ')') depth -= 1;
    if (text[i] === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }

  parts.push(text.slice(start));
  return parts;
}

const compare = (a, b) => {
  const da = Date.parse(a);
  const db = Date.parse(b);
  if (typeof a === 'string' && !Number.isNaN(da) && !Number.isNaN(db) && /\d{4}-/.test(b)) return da - db;
  return Number(a) - Number(b);
};

function operator(column, expression) {
  const dot = expression.indexOf('.');
  const op = expression.slice(0, dot);
  const value = expression.slice(dot + 1);

  return (row) => {
    const field = row[column];
    const present = field !== null && field !== undefined;

    switch (op) {
      case 'eq':
        return present && String(field) === value;
      case 'neq':
        return present && String(field) !== value;
      case 'lt':
        return present && compare(field, value) < 0;
      case 'in':
        return present && value.slice(1, -1).split(',').includes(String(field));
      case 'is':
        return value === 'null' ? !present : false;
      default:
        throw new Error(`fake PostgREST: unsupported operator ${op}`);
    }
  };
}

function condition(text) {
  const logical = text.match(/^(or|and)\((.*)\)$/);

  if (logical) {
    const parts = splitTop(logical[2]).map(condition);
    return logical[1] === 'or' ? (row) => parts.some((p) => p(row)) : (row) => parts.every((p) => p(row));
  }

  const dot = text.indexOf('.');
  return operator(text.slice(0, dot), text.slice(dot + 1));
}

function parseQuery(query) {
  const filters = [];
  let limit = Infinity;
  let onConflict = null;

  for (const pair of query.split('&').filter(Boolean)) {
    const eq = pair.indexOf('=');
    const key = pair.slice(0, eq);
    const value = decodeURIComponent(pair.slice(eq + 1));

    if (key === 'select' || key === 'order') continue;
    if (key === 'on_conflict') onConflict = value;
    else if (key === 'limit') limit = Number(value);
    else if (key === 'or' || key === 'and') filters.push(condition(`${key}${value}`));
    else filters.push(operator(key, value));
  }

  return { filter: (row) => filters.every((fn) => fn(row)), limit, onConflict };
}

export const respond = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => 'application/json' },
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
});

export const PORTAL = 'https://portal.frontiva.online';

/**
 * @param {Object} options
 * @param {Object<string, Object[]>} [options.tables]
 * @param {Object[]} [options.products]
 * @param {(body: Object, headers: Object) => Object|Promise<Object>} [options.login] - returns a response
 * @param {(body: Object, headers: Object) => Object|Promise<Object>} [options.create]
 * @param {(ref: string, headers: Object) => Object|Promise<Object>} [options.status]
 * @param {(table: string, method: string) => Object|null} [options.dbFault] - return a response to fail a DB call
 */
export function installWorld({ tables = {}, products = [], login, create, status, dbFault } = {}) {
  const state = {
    tables: { orders: [], frontiva_payin_transactions: [], ...structuredClone(tables) },
    logins: [],
    creates: [],
    statuses: [],
    forbidden: [],
    nextId: 100,
  };

  globalThis.fetch = async (url, options = {}) => {
    await new Promise((resolve) => setImmediate(resolve));
    const target = String(url);
    const method = options.method || 'GET';

    if (target.startsWith('https://db.test/rest/v1/')) {
      const [table, query = ''] = target.slice('https://db.test/rest/v1/'.length).split('?');
      const body = options.body ? JSON.parse(options.body) : null;
      const fault = dbFault?.(table, method);

      if (fault) return fault;
      if (table === 'products') return respond(200, products);

      const rows = (state.tables[table] ||= []);
      const { filter, limit, onConflict } = parseQuery(query);

      if (method === 'GET') return respond(200, rows.filter(filter).slice(0, limit));

      if (method === 'POST') {
        if (onConflict && rows.some((row) => String(row[onConflict]) === String(body[onConflict]))) {
          return respond(201, []);
        }

        const row = { id: state.nextId++, created_at: new Date().toISOString(), ...body };
        rows.push(row);
        return respond(201, [{ ...row }]);
      }

      if (method === 'PATCH') {
        const matched = rows.filter(filter);
        matched.forEach((row) => Object.assign(row, body));
        return respond(200, matched.map((row) => ({ ...row })));
      }
    }

    if (target === `${PORTAL}/api/auth/user/login`) {
      state.logins.push(JSON.parse(options.body));
      return login(JSON.parse(options.body), options.headers);
    }

    if (target === `${PORTAL}/api/payin-requests` && method === 'POST') {
      const body = JSON.parse(options.body);
      state.creates.push({ body, headers: options.headers });
      return create(body, options.headers);
    }

    if (target.startsWith(`${PORTAL}/api/payin-requests?merchantReference=`) && method === 'GET') {
      const ref = decodeURIComponent(target.split('merchantReference=')[1]);
      state.statuses.push({ ref, headers: options.headers });
      return status(ref, options.headers);
    }

    if (/airpay\.co\.in|sabpaisa\.in|kkchat\.in/.test(target)) {
      state.forbidden.push(target);
      return respond(500, 'must not be called');
    }

    throw new Error(`unexpected request to ${method} ${target}`);
  };

  return state;
}
