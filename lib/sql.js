/*jslint node: true*/
'use strict';

var pg = require('pg');
var async = require('async');
var crypto = require('crypto');

function refresh_ip_pool_sql(params, attrs, cb) {
    var query,
        framedip;
    
    if (params.req.attributes['Acct-Status-Type'] === 'Stop') {
        query = "UPDATE radippool SET callingstationid = $1, username = $2, " +
            "nasipaddress = $4, expiry_time = NOW() WHERE framedipaddress = $3";
    } else {
        query = "UPDATE radippool SET callingstationid = $1, username = $2, " +
            "nasipaddress = $4, expiry_time = NOW() + '00:10:00' WHERE framedipaddress = $3";
    }
    
    //If we're accounting, the IP comes in the request, if we're authorizing, it comes in the reply
    if (params.req.attributes['Framed-IP-Address']) {
        framedip = params.req.attributes['Framed-IP-Address'];
    } else {
        framedip = params.res.attributes['Framed-IP-Address'];
    }

    pg.connect(params.api.config.get('modules')['halbmesser-postgresql'].db, function (err, client, done) {
        client.query(query, [
            params.req.attributes['Calling-Station-Id'],
            params.req.attributes['User-Name'],
            framedip,
            params.req.attributes['NAS-IP-Address']
        ], function (err, result) {
            done();
            
            if (err) {
                cb(false);
            } else {
                cb(true);
            }
        });
    });
}

function ip_pool_sql(params, attrs, cb) {
    //With this woodoo query what we try to do is to reuse this user's old IP should it be still available,
    //otherwise, he gets a new one.
    var query = "SELECT old_addy.framedipaddress AS old_addy, " +
        "next_free.framedipaddress AS next_free " +
        "FROM (SELECT framedipaddress FROM radippool WHERE username = $2 AND pool_name = $1 LIMIT 1) AS old_addy " +
        "FULL OUTER JOIN (SELECT framedipaddress FROM radippool " +
        "WHERE expiry_time < now() AND pool_name = $1 LIMIT 1) AS next_free ON true";

    pg.connect(params.api.config.get('modules')['halbmesser-postgresql'].db, function (err, client, done) {
        client.query(query, [
            params.user.attributes['Pool-Name'],
            params.req.attributes['User-Name']
        ], function (err, result) {
            var framedip;
            
            done();
            if (err) {
                cb(false);
                return;
            }
                        
            if (result.rows[0].old_addy === null) {
                framedip = result.rows[0].next_free;
            } else {
                framedip = result.rows[0].old_addy;
            }

            params.res.attributes['Framed-IP-Address'] = framedip;

            refresh_ip_pool_sql(params, null, cb);
        });
    });
}

function load_user_sql(params, attrs, cb) {
    pg.connect(params.api.config.get('modules')['halbmesser-postgresql'].db, function (err, client, done) {
        async.parallel({
            radcheck: function (cb) {
                client.query("SELECT * FROM radcheck WHERE username = $1", [params.req.attributes['User-Name']], cb);
            },
            radreply: function (cb) {
                client.query("SELECT * FROM radreply WHERE username = $1", [params.req.attributes['User-Name']], cb);
            }
        }, function (err, results) {
            done();
                        
            if (err) {
                cb(false);
                return;
            }

            results.radcheck.rows.forEach(function (row) {
                params.user.attributes[row.attribute] = row.value;
            });
            
            results.radreply.rows.forEach(function (row) {
                params.res.attributes[row.attribute] = row.value;
            });

            if (results.radcheck.rows.length !== 0) {
                cb(true);
            } else {
                cb(false);
            }
        });
    });
}

function account_sql(params, attrs, cb) {
    var query, acctUniqueId;

    pg.connect(params.api.config.get('modules')['halbmesser-postgresql'].db, function (err, client, done) {
        if (params.req.attributes['Acct-Status-Type'] === 'Start') {
            query = "INSERT INTO radacct " +
                "(acctsessionid, acctuniqueid, username, nasipaddress, " +
                "nasportid, nasporttype, acctstarttime, acctauthentic, " +
                "calledstationid, callingstationid, servicetype, " +
                "framedprotocol, framedipaddress) VALUES " +
                "($1, $2, $3, $4, $5, $6, now(), $7, $8, $9, $10, $11, $12)";

            acctUniqueId = crypto.randomBytes(8).toString('hex');

            client.query(query, [
                params.req.attributes['Acct-Session-Id'],
                acctUniqueId,
                params.req.attributes['User-Name'],
                params.req.attributes['NAS-IP-Address'],
                params.req.attributes['NAS-Port'],
                params.req.attributes['NAS-Port-Type'],
                params.req.attributes['Acct-Authentic'],
                params.req.attributes['Called-Station-Id'],
                params.req.attributes['Calling-Station-Id'],
                params.req.attributes['Service-Type'],
                params.req.attributes['Framed-Protocol'],
                params.req.attributes['Framed-IP-Address']
            ], function (err) {
                done();
                cb(err === undefined);
            });
        } else if (params.req.attributes['Acct-Status-Type'] === 'Interim-Update') {
            query = "UPDATE radacct SET acctinputoctets = $1, acctoutputoctets = $2 WHERE nasipaddress = $3 AND acctsessionid = $4";

            client.query(query, [
                params.req.attributes['Acct-Input-Octets'],
                params.req.attributes['Acct-Output-Octets'],
                params.req.attributes['NAS-IP-Address'],
                params.req.attributes['Acct-Session-Id']
            ], function (err) {
                done();
                cb(err === undefined);
            });
        } else if (params.req.attributes['Acct-Status-Type'] === 'Stop') {
            query = "UPDATE radacct SET acctinputoctets = $1, acctoutputoctets = $2, acctstoptime = now() WHERE nasipaddress = $3 AND acctsessionid = $4";

            client.query(query, [
                params.req.attributes['Acct-Input-Octets'],
                params.req.attributes['Acct-Output-Octets'],
                params.req.attributes['NAS-IP-Address'],
                params.req.attributes['Acct-Session-Id']
            ], function (err) {
                done();
                cb(err === undefined);
            });
        }
    });
}

function start_module(api) {
    pg.defaults.poolIdleTimeout = 600000; //10 min
    
    api.registry.addFunction('load_user_sql', load_user_sql);
    api.registry.addFunction('ip_pool_sql', ip_pool_sql);
    api.registry.addFunction('refresh_ip_pool_sql', refresh_ip_pool_sql);
    api.registry.addFunction('account_sql', account_sql);
}

exports.start_module = start_module;