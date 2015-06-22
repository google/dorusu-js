'use strict';

var app = require('../lib/app');
var bunyan = require('bunyan');
var path = require('path');
var protobuf = require('../lib/protobuf');
var nurpc = require('../lib/nurpc');
var server = require('../lib/server');

var logOutput = process.stderr;
var logger = bunyan.createLogger({
  name: 'math_server',
  stream: logOutput,
  serializers: require('http2').serializers
});

/**
 * Server function for division.
 *
 * Supports the /Math/DivMany and /Math/Div handlers
 * (Div is just DivMany with only one stream element). For each
 * DivArgs parameter, responds with a DivReply with the results of the division
 *
 * @param {Object} call The object containing request and cancellation info
 * @param {function(Error, *)} cb Response callback
 */
function mathDiv(request, response) {
  request.on('data', function(msg) {
    console.log('received', msg);
    if (+msg.divisor === 0) {
      response.rpcMessage = 'cannot divide by zero';
      response.rpcCode = nurpc.rpcCodes('INVALID_ARGUMENT');
    } else {
      response.write({
        quotient: msg.dividend / msg.divisor,
        remainder: msg.dividend % msg.divisor
      });
    }
  });
  request.on('end', function(data) {
    console.log('Ended with', data);
  });
};

var main = function main() {
  var mathpb = protobuf.loadProto(path.join(__dirname, 'math.proto'));
  var mathApp = new app.RpcApp(mathpb.math.Math.server);
  mathApp.register('/math.Math/DivMany', mathDiv);
  mathApp.register('/math.Math/Div', mathDiv);
  mathApp.register('/math.Math/Fib', nurpc.notFound);
  mathApp.register('/math.Math/Sum', nurpc.notFound);

  var s = server.raw.createServer({
    log: logger,
    app: mathApp
  });
  s.listen(50051);
};

if (require.main === module) {
  main();
}
