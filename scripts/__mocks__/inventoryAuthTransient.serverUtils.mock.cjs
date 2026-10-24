'use strict';

module.exports = {
  async runWithUserPoolServerContext({ operation }) {
    return operation({});
  },
};
