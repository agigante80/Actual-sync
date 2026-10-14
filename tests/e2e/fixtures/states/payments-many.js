// 50 schedules, 15 needing attention (#341).
const { AS_OF_MIN, CONFIGURED, ev } = require('./_payments');

const CYCLE = ['missing', 'received', 'upcoming', 'wrongAmount', 'late', 'cannotCheck', 'received', 'skipped', 'upcoming', 'received'];

module.exports = {
  servers: [{ name: 'Main', ...CONFIGURED }],
  seed(s) {
    const items = [];
    for (let i = 0; i < 50; i++) {
      const n = String(i).padStart(2, '0');
      items.push(ev(`item-${n}`, `Schedule ${n}`, CYCLE[i % CYCLE.length], {
        deadline: `2026-01-${String(1 + (i % 28)).padStart(2, '0')}`
      }));
    }
    s.payments('Main', items, {}, AS_OF_MIN);
  }
};
