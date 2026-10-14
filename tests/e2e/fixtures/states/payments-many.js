// 50 schedules, 15 needing attention (#341).
const { AS_OF_MIN, configuredFor, ev } = require('./_payments');

const CYCLE = ['missing', 'received', 'upcoming', 'wrongAmount', 'late', 'cannotCheck', 'received', 'skipped', 'upcoming', 'received'];

const ITEMS = [];
for (let i = 0; i < 50; i++) {
  const n = String(i).padStart(2, '0');
  ITEMS.push(ev(`item-${n}`, `Schedule ${n}`, CYCLE[i % CYCLE.length], {
    deadline: `2026-01-${String(1 + (i % 28)).padStart(2, '0')}`
  }));
}

module.exports = {
  servers: [{ name: 'Main', ...configuredFor(ITEMS) }],
  seed(s) {
    s.payments('Main', ITEMS, {}, AS_OF_MIN);
  }
};
