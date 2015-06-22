'use strict';

var _ = require('lodash');
var app = require('../lib/app');
var expect = require('chai').expect;
var path = require('path');
var protobuf = require ('../lib/protobuf');

describe('`function loadProto(path, [format])`', function() {
  it('should load a proto file by default', function() {
    var isOK = function isOK() {
      protobuf.loadProto(fixturePath('test_service.proto'));
    };
    expect(isOK).to.not.throw(Error);
  });
  it('should load a proto file with the proto format', function() {
    var isOK = function isOK() {
      protobuf.loadProto(fixturePath('test_service.proto'), 'proto');
    };
    expect(isOK).to.not.throw(Error);
  });
  it('should load a json file with the json format', function() {
    var isOK = function isOK() {
      protobuf.loadProto(fixturePath('test_service.json'), 'json');
    };
    expect(isOK).to.not.throw(Error);
  });
  it('should fail to load a file with an unknown format', function() {
    var shouldThrow = function shouldThrow() {
      protobuf.loadProto(fixturePath('test_service.proto'), 'fake_format');
    };
    expect(shouldThrow).to.throw(Error);
  });
  it('should load service defined in the proto', function() {
    var testProto = protobuf.loadProto(fixturePath('test_service.proto'));
    _.forEach(['client', 'server'], function(side) {
      var got = testProto['TestService'][side];
      expect(got).to.be.an.instanceof(app.Service);
      expect(got.name).to.eql('TestService');
      var methods = _.map(got.methods, function(m) { return m.name});
      expect(methods).to.eql(['Unary', 'ClientStream', 'ServerStream',
                              'BidiStream']);
    });
  });
  it('should load service defined in a proto with a package', function() {
    var mathProto = protobuf.loadProto(examplePath('math.proto'));
    _.forEach(['client', 'server'], function(side) {
      var got = mathProto.math.Math[side];
      expect(got).to.be.an.instanceof(app.Service);
      expect(got.name).to.eql('math.Math');
      var methods = _.map(got.methods, function(m) { return m.name});
      expect(methods).to.eql(['Div', 'DivMany', 'Fib', 'Sum']);
    });
  });
});

var fixturePath = function fixturePath(p) {
  return path.join(__dirname, 'fixtures', p);
}

var examplePath = function examplePath(p) {
  return path.join(__dirname, '../example', p);
}
