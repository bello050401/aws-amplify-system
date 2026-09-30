'use strict';

let phase = 'first';
const calls = { item: 0, statuses: 0, fields: 0, categories: 0, locations: 0 };
const throttle = () => ({ name: 'NoSignedUser', underlyingError: { name: 'TooManyRequestsException' } });
const unexpected = new Error('unexpected read failure');

module.exports = {
  calls,
  unexpected,
  __setPhase(value) {
    phase = value;
    for (const key of Object.keys(calls)) calls[key] = 0;
  },
  async getInventoryDetail(id) {
    calls.item += 1;
    if (phase === 'first') throw throttle();
    if (phase === 'unknown') throw unexpected;
    return { id, categoryId: null, locationId: null };
  },
  async listStatuses() { calls.statuses += 1; return []; },
  async listCustomFieldDefinitions() { calls.fields += 1; return []; },
  async listCategories() { calls.categories += 1; if (phase === 'second') throw throttle(); return []; },
  async listLocations() { calls.locations += 1; return []; },
};
