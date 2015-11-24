/**
 * nurpc/example/certs gives access to the test credentials used in examples
 * and tests.
 *
 * @module nurpc/example/certs
 */

var _ = require('lodash');
var fs = require('fs');
var path = require('path');

exports.serverOptions = {
  key: fs.readFileSync(path.join(__dirname, 'certs/server1.key')),
  cert: fs.readFileSync(path.join(__dirname, 'certs/server1.pem'))
};

exports.clientOptions = {
  ca: fs.readFileSync(path.join(__dirname, 'certs/ca.pem'))
};

exports.options = _.merge(exports.serverOptions, exports.clientOptions);
