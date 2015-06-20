'use strict';

var _ = require('lodash');
var app = require('../lib/app');
var expect = require('chai').expect;
var irreverser = require('./util').irreverser;
var reverser = require('./util').reverser;

var testSvc = app.Service('test', [
  app.Method('do_reverse', reverser, irreverser)
]);
var basicSvc = app.Service('basic', [
  app.Method('noop')
]);

describe('RpcApp', function() {
  var theApp;
  beforeEach(function(){
    theApp = new app.RpcApp();
  });
  it ('can take services in its constructor', function() {
    expect(function() { new app.RpcApp(testSvc, basicSvc) }).to.not.throw(Error);
  });
  describe('method `addServices(aService)`', function() {
    it('should throw if a service is added twice', function() {
      theApp.addService(testSvc);
      expect(function() { theApp.addService(testSvc) }).to.throw(Error);
    });
    it('should throw if a service is added again', function() {
      var anotherApp = new app.RpcApp(testSvc, basicSvc);
      expect(function() { anotherApp.addService(testSvc) }).to.throw(Error);
    });
  });
  describe('method `unmarshaller(route)`', function() {
    beforeEach(function(){
      theApp.addService(testSvc);
      theApp.addService(basicSvc);
    });
    it('should be undefined for unknown routes', function() {
      expect(theApp.unmarshaller('this-does-no-exist')).to.be.undefined;
    });
    it('should be defined for known routes', function() {
      expect(theApp.unmarshaller('/test/do_reverse')).to.not.be.undefined;
    });
    it('should be undefined if a method had no unmarshaller', function() {
      expect(theApp.unmarshaller('/basic/noop')).to.be.undefined;
    });
  });
  describe('method `marshaller(route)`', function() {
    beforeEach(function(){
      theApp.addService(testSvc);
      theApp.addService(basicSvc);
    });
    it('should be undefined for unknown routes', function() {
      expect(theApp.marshaller('this-does-no-exist')).to.be.undefined;
    });
    it('should be defined for known routes', function() {
      expect(theApp.marshaller('/test/do_reverse')).to.not.be.undefined;
    });
    it('should be undefined if a method had no marshaller', function() {
      expect(theApp.marshaller('/basic/noop')).to.be.undefined;
    });
  });
  describe('method `missingRoutes`', function() {
    beforeEach(function(){
      theApp.addService(testSvc);
      theApp.addService(basicSvc);
    });
    it('should contain all routes that have no handler registered', function() {
      expect(theApp.missingRoutes()).to.eql([
        '/test/do_reverse',
        '/basic/noop'
      ]);
    });
    it('should not contain routes that have a handler registered', function() {
      theApp.register('/basic/noop', _.noop);
      expect(theApp.missingRoutes()).to.eql([
        '/test/do_reverse'
      ]);
    });
  });
  describe('method `hasRoute`', function() {
    beforeEach(function(){
      theApp.addService(testSvc);
      theApp.addService(basicSvc);
    });
    it('should indicate when a route has been registered', function() {
      expect(theApp.hasRoute('/basic/noop')).to.be.false;
      theApp.register('/basic/noop', _.noop);
      expect(theApp.hasRoute('/basic/noop')).to.be.true;
    });
  });
  describe('method `register`', function() {
    beforeEach(function(){
      theApp.addService(testSvc);
      theApp.addService(basicSvc);
    });
    it('should adds dispatch functions to routes', function() {
      expect(theApp.hasRoute('/basic/noop')).to.be.false;
      theApp.register('/basic/noop', _.noop);
      expect(theApp.hasRoute('/basic/noop')).to.be.true;
    });
    it('should fail if the same route is registered twice', function() {
      theApp.register('/basic/noop', _.noop);
      expect(function() {
        theApp.register('/basic/noop', _.noop);
      }).to.throw(Error);
    });
    it('should fail if an unspecified route is registered', function() {
      expect(function() {
        theApp.register('this-does-not-required', _.noop);
      }).to.throw(Error);
    });
  });
  describe('method `isComplete`', function() {
    beforeEach(function(){
      theApp.addService(testSvc);
      theApp.addService(basicSvc);
    });
    it('should be false if there are unsatisfied routes', function() {
      expect(theApp.isComplete()).to.be.false;
      theApp.register('/basic/noop', _.noop);
      expect(theApp.isComplete()).to.be.false;
    });
    it('should be true when all required routes are present', function() {
      expect(theApp.isComplete()).to.be.false;
      theApp.register('/basic/noop', _.noop);
      expect(theApp.isComplete()).to.be.false;
      theApp.register('/test/do_reverse', _.noop);
      expect(theApp.isComplete()).to.be.true;
    });
  });
});
