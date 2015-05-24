use strict;

// 1) start of by sending writing a client capable of sending a unary request and handling the response
// 2) follow-up by writing a client capable of sending a streaming request and handling a unary response
// 3) update 3 by allowing the response to be streaming=]
// 4) refactor from 4, so that all cardinalities are handled

// 5) no servers, use existing grpc implementations if it's possible to use these without protocol buffers


// How do I send headers ?
// What should I send in  the first request ?
// How do I write a test that simulates a response ?
// How do I write a test that simulates a request sent over multiple frames ?
// How do I write a tests that simulates a response sent over multiple frames ?
// Should I start with the server first, or the client first ?

// Snippet: creating an insecure http2 endpoint
//
// endpoint = new Endpoint(this._log, 'CLIENT', this._settings);
// endpoint.socket = net.connect({
//   host: options.host,
//   port: options.port,
//   localAddress: options.localAddress
// });
// endpoint.pipe(endpoint.socket).pipe(endpoint);


// Note:
//
// Agent.prototype.request seems to be the equivalent of a channel
// Channel == Agent

// Stub: surface
// - constructor should allow method, timeout, agent?, creds?, host?

// TODO

module.exports = require('./nurpc');
