'use strict';
let role = 'ADMIN';
module.exports = {
  __setRole(value) { role = value; },
  async getInventoryRole() { return role; },
  canEditInventory() { return false; },
  canHardDeleteInventory() { return false; },
};
