'use strict';

module.exports = {
  async runWithAmplifyServerContext({ operation }) {
    return operation({});
  },
};

module.exports.runWithUserPoolServerContext = module.exports.runWithAmplifyServerContext;
