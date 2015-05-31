/*jslint node: true nomen: true*/
/*global describe, it, before, beforeEach*/
'use strict';

var rewire = require('rewire');
var sinon = require('sinon');
var expect = require('chai').expect;
var sql = rewire('../lib/sql');
var pgtest = require('pgtest');

describe('Halbmesser PostgreSQL driver', function () {
    var pgMock, params, load_user_sql;
    
    before(function () {
        load_user_sql = sql.__get__('load_user_sql');
        sql.__set__('pg', pgtest);
    });
    
    beforeEach(function () {
        params = {
            api: {
                config: {
                    get: sinon.stub().returns({
                        'halbmesser-postgresql': {
                            db: "db://test"
                        }
                    })
                }
            },
            req: {
                attributes: {
                    'User-Name': 'testUser'
                }
            },
            res: {
                attributes: {}
            },
            user: {
                attributes: {}
            }
        };
        
        pgtest.reset();
    });
    
    describe('load_user_sql', function () {
        it('should return false if the user was not found in radcheck', function () {
            pgtest.expect('SELECT * FROM radcheck WHERE username = $1', ['testUser']).returning(null, []);
            pgtest.expect('SELECT * FROM radreply WHERE username = $1', ['testUser']).returning(null, []);

            load_user_sql(params, [], function (r) {
                pgtest.check();
                expect(params.user.attributes).to.be.deep.equal({});
                expect(r).to.be.equal(false);
            });
        });

        it('should return true and update params if the user was found in radcheck', function () {
            pgtest.expect('SELECT * FROM radcheck WHERE username = $1', ['testUser']).returning(null, [{
                username: 'testUser',
                attribute: 'Cleartext-Password',
                op: ':=',
                value: 'clientPass'
            }]);
            pgtest.expect('SELECT * FROM radreply WHERE username = $1', ['testUser']).returning(null, []);

            load_user_sql(params, [], function (r) {
                pgtest.check();
                expect(r).to.be.equal(true);
                expect(params.user.attributes).to.be.deep.equal({
                    'Cleartext-Password': 'clientPass'
                });
                expect(params.user.attributes['Cleartext-Password']).to.be.equal('clientPass');
            });
        });

        it('should return false but update params if user was only found in radreply', function () {
            pgtest.expect('SELECT * FROM radcheck WHERE username = $1', ['testUser']).returning(null, []);
            pgtest.expect('SELECT * FROM radreply WHERE username = $1', ['testUser']).returning(null, [{
                username: 'testUser',
                attribute: 'Framed-IP-Address',
                'op': '=',
                'value': '192.168.1.2'
            }]);

            load_user_sql(params, [], function (r) {
                pgtest.check();
                expect(params.user.attributes).to.be.deep.equal({});
                expect(params.res.attributes).to.be.deep.equal({
                    'Framed-IP-Address': '192.168.1.2'
                });
                expect(r).to.be.equal(false);
            });
        });
        
        it('should return false in case of error in any of the queries', function () {
            pgtest.expect('SELECT * FROM radcheck WHERE username = $1', ['testUser']).returning(null, []);
            pgtest.expect('SELECT * FROM radreply WHERE username = $1', ['testUser']).returning('err', []);
            load_user_sql(params, [], function (r) {
                expect(r).to.be.equal(false);
            });
            pgtest.check();
            pgtest.reset();
            
            pgtest.expect('SELECT * FROM radcheck WHERE username = $1', ['testUser']).returning('err', []);
            pgtest.expect('SELECT * FROM radreply WHERE username = $1', ['testUser']).returning(null, []);

            load_user_sql(params, [], function (r) {
                expect(r).to.be.equal(false);
            });
            pgtest.check();
        });
    });
});
