'use strict';

module.exports = {
  async runWithAmplifyServerContext({ operation }) {
    return operation({});
  },
};
