/**
 *  apiResponder.js; Handles responses to API requests for MochiMap
 *  Copyright (C) 2021  Chrisdigity
 *
 *  This program is free software: you can redistribute it and/or modify
 *  it under the terms of the GNU Affero General Public License as published
 *  by the Free Software Foundation, either version 3 of the License, or
 *  (at your option) any later version.
 *
 *  This program is distributed in the hope that it will be useful,
 *  but WITHOUT ANY WARRANTY; without even the implied warranty of
 *  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *  GNU Affero General Public License for more details.
 *
 *  You should have received a copy of the GNU Affero General Public License
 *  along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 */

/* global BigInt */

// monkey-patch BigInt serialization
/* eslint no-extend-native: ["error", { "exceptions": ["BigInt"] }] */
BigInt.prototype.toJSON = function () { return Number(this.toString()); };

/* full node ipv4 check */
if (typeof process.env.FULLNODE === 'undefined') {
  console.warn('// WARNING: Mochimo full node ipv4 is undefined');
  console.warn('// Balance requests produce unexpected results...');
}

const { createHash } = require('crypto');
const { blockReward, projectedSupply, round } = require('./apiUtils');
const Interpreter = require('./apiInterpreter');
const Db = require('./apiDatabase');
const Mochimo = require('mochimo');

const expandResults = async (cursor, options, start) => {
  const dbquery = { duration: null, found: await cursor.count() };
  if (options.limit) { // update number of pages in results
    dbquery.pages = Math.ceil(dbquery.found / options.limit);
  } // apply cursor array to results and update duration stat
  dbquery.results = await cursor.toArray();
  dbquery.duration = Date.now() - start;
  return dbquery;
};

const Responder = {
  _respond: (res, statusCode, json, statusMessage = false) => {
    if (!statusMessage) {
      switch (statusCode) {
        case 200: statusMessage = 'OK'; break;
        case 400: statusMessage = 'Bad Request'; break;
        case 404: statusMessage = 'Not Found'; break;
        case 406: statusMessage = 'Not Acceptable'; break;
        case 409: statusMessage = 'Conflict'; break;
        case 422: statusMessage = 'Unprocessable Entity'; break;
        case 500: statusMessage = 'Internal Server Error'; break;
        default: statusMessage = '';
      }
    }
    // assign error and message properties if required
    if (statusCode > 299 && !json.error) {
      json = Object.assign({ error: statusMessage }, json);
    }
    // process response headers
    const body = JSON.stringify(json, null, 2) || '';
    const headers = {
      'X-Robots-Tag': 'none',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'X-XSS-Protection': '1; mode=block',
      'Referrer-Policy': 'no-referrer',
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
      'Access-Control-Allow-Origin': '*'
    };
    // send response
    res.writeHead(statusCode, statusMessage, headers);
    res.end(body);
  },
  block: async (res, blockNumber, blockHex) => {
    try {
      const query = {}; // undefined blockNumber/blockHex will find latest
      if (typeof blockNumber === 'undefined') blockNumber = blockHex;
      if (typeof blockNumber !== 'undefined') {
        // convert blockNumber parameter to Long number type from Big Integer
        query.bnum = Db.util.long(BigInt(blockNumber));
      }
      // perform block query
      const block = await Db.findOne('block', query);
      // send successfull query or 404
      return Responder._respond(res, block ? 200 : 404, block ||
        { message: `${blockNumber} could not be found...` });
    } catch (error) { Responder.unknownInternal(res, error); }
  },
  chain: async (res, blockNumber, blockHex) => {
    try {
      let chain;
      const target = 768;
      // convert blockNumber to Number value
      if (typeof blockNumber === 'undefined') blockNumber = blockHex;
      if (typeof blockNumber === 'undefined') blockNumber = -target;
      else blockNumber = Number(blockNumber);
      // calculate partial tfile parameters
      const count = blockNumber < target ? Math.abs(blockNumber) + 1 : target;
      const start = blockNumber > -1 ? blockNumber - (count - 1) : blockNumber;
      const tfile = await Mochimo.getTfile(process.env.FULLNODE, start, count);
      if (tfile) { // ensure tfile contains the requested block
        const tfileCount = tfile.length / Mochimo.BlockTrailer.length;
        const rTrailer = tfile.trailer(tfileCount - 1);
        if (blockNumber < 0 || blockNumber === Number(rTrailer.bnum)) {
          // deconstruct trailers and perform chain calculations
          let supply;
          let rewards = 0n;
          let pseudorate = 0;
          let nonNeogenesis = 0;
          let transactions = 0;
          let blockTimes = 0;
          let hashesTimes = 0;
          let hashes = 0;
          let difficulties = 0;
          let index = tfile.length / Mochimo.BlockTrailer.length;
          for (index--; index >= 0; index--) {
            const trailer = tfile.trailer(index);
            const { bnum, bhash, mfee, tcount } = trailer;
            if (bnum & 0xffn) { // NON-(NEO)GENSIS block type
              const dT = trailer.stime - trailer.time0;
              difficulties += trailer.difficulty;
              blockTimes += dT;
              nonNeogenesis++;
              if (tcount) { // NORMAL block types
                transactions += tcount;
                hashesTimes += dT;
                hashes += Math.pow(2, trailer.difficulty);
                rewards += blockReward(bnum) + (mfee * BigInt(tcount));
              } else pseudorate++; // PSEUDO block types
            } else if (!supply) { // (NEO)GENSIS block types
              try { // obtain ledger amount from database
                const query = { _id: Db.util.id.block(bnum, bhash) };
                const ng = await Db.findOne('block', query);
                Db.util.filterLong(ng); // ensure long values are BigInt
                if (ng && ng.amount) { // preform supply calculations
                  supply = ng.amount + rewards;
                  // calculate lost supply and subtract from max supply
                  const lostsupply = projectedSupply(rTrailer.bnum) - supply;
                  const maxsupply = projectedSupply() - lostsupply;
                  chain = { maxsupply, supply };
                }
              } catch (ignore) {}
            }
          } // if chain is undefined by this point, neogenesis search failed ~3x
          if (chain) { // chain is available, perform remaining calculations
            const rTrailerJSON = rTrailer.toJSON();
            const { bhash, phash, mroot, nonce, bnum, mfee } = rTrailerJSON;
            const { difficulty, tcount, time0, stime } = rTrailerJSON;
            const isNeogenesis = Boolean(!(bnum & 0xffn));
            const json = { bhash, phash, mroot, nonce };
            if (nonce !== ''.padStart(64, 0)) {
              json.haiku = Mochimo.Trigg.expand(nonce);
            }
            json.bnum = bnum;
            json.mfee = mfee;
            json.time0 = time0;
            json.stime = stime;
            json.blocktime = isNeogenesis ? 0 : stime - time0;
            json.blocktime_avg = round(blockTimes / nonNeogenesis);
            json.tcount = tcount;
            json.tcount_avg = round(transactions / nonNeogenesis);
            json.tcountpsec = round(tcount / json.blocktime);
            json.tcountpsec_avg = round(transactions / blockTimes);
            json.txfees = isNeogenesis ? 0 : BigInt(tcount) * mfee;
            json.reward = isNeogenesis ? 0 : blockReward(bnum);
            json.mreward = isNeogenesis ? 0 : json.txfees + json.reward;
            json.difficulty = difficulty;
            json.difficulty_avg = round(difficulties / nonNeogenesis);
            json.hashrate = json.tcount === 0 ? 0
              : round(Math.pow(2, difficulty) / json.blocktime);
            json.hashrate_avg = round(hashes / hashesTimes);
            json.pseudorate_avg = round(pseudorate / nonNeogenesis);
            // add json trailer data of requested block number to chain request
            chain = Object.assign(json, chain);
          }
        }
      }
      // ensure chain was filled
      // send successfull acquisition or 404
      return Responder._respond(res, chain ? 200 : 404, chain ||
        { message: 'chain data unavailable...' });
    } catch (error) { Responder.unknownInternal(res, error); }
  },
  ledger: async (res, addressType, address) => {
    try {
      // perform balance request
      const isTag = Boolean(addressType === 'tag');
      let le = await Mochimo.getBalance(process.env.FULLNODE, address, isTag);
      if (le) { // deconstruct ledger entry and compute sha256 of address
        const { address, balance, tag } = le;
        const addressHash = createHash('sha256').update(address).digest('hex');
        // reconstruct ledger entry with sha256
        le = { address, addressHash, tag, balance };
      }
      // send successfull query or 404
      return Responder._respond(res, le ? 200 : 404, le ||
        { message: `${isTag ? 'tag' : 'wots+'} not found in ledger...` });
    } catch (error) { Responder.unknownInternal(res, error); }
  },
  network: async (res, status, ip) => {
    try {
      // move ip argument if no status was provided
      ip = ip || status;
      // perform network query
      const node = await Db.findOne('network', { 'host.ip': ip });
      // apply applicable status filter
      if (node && status === 'active') {
        // check for incomplete data
        if (typeof node.connection !== 'object') {
          Responder.unknownInternal(res,
            { message: `${ip} is missing connection object...` });
        }
        // check all available regions
        for (const region of Object.values(node.connection)) {
          if (region.status) { // send 404 if any region returns not OK status
            return Responder._respond(res, 404,
              { message: `${ip} node is not OK in all regions...` });
          }
        }
      }
      // send successfull query or 404
      return Responder._respond(res, node ? 200 : 404, node ||
        { message: `${ip} could not be found...` });
    } catch (error) { Responder.unknownInternal(res, error); }
  },
  search: async (cName, paged, res, ...args) => {
    const start = Date.now();
    let cursor;
    try {
      // set defaults and interpret requested search params as necessary
      const search = { query: {}, options: {} };
      Object.assign(search, Interpreter.search(args[0], paged, cName));
      // query database for results
      cursor = await Db.find(cName, search.query, search.options);
      const dbquery = await expandResults(cursor, search.options, start);
      // send succesfull query or 404
      if (dbquery.results.length) Responder._respond(res, 200, dbquery);
      else Responder._respond(res, 404, dbquery, 'No results');
    } catch (error) { // send 500 on internal error
      Responder.unknownInternal(res, error);
    } finally { // cleanup cursor
      if (cursor && !cursor.isClosed()) await cursor.close();
    }
  },
  searchBlock: (...args) => Responder.search('block', 1, ...args),
  searchLedger: (...args) => Responder.search('ledger', 1, ...args),
  searchNetwork: (...args) => Responder.search('network', 0, ...args),
  searchRichlist: (...args) => Responder.search('richlist', 1, ...args),
  searchTransaction: (...args) => Responder.search('transaction', 1, ...args),
  transaction: async (res, txid) => {
    try {
      // perform transaction query
      const transaction = await Db.findOne('transaction', { txid });
      // send successfull query or 404
      return Responder._respond(res, transaction ? 200 : 404, transaction ||
        { message: `${txid} could not be found...` });
    } catch (error) { Responder.unknownInternal(res, error); }
  },
  unknown: (res, code = 200, json = {}) => Responder._respond(res, code, json),
  unknownInternal: (res, error) => {
    // log error and send alert response
    console.trace(error);
    const date = new Date();
    Responder.unknown(res, 500, {
      message: 'MochiMap API has encountered an unexpected error. ' +
        'Please try again later.  @ ' +
        'https://github.com/chrisdigity/api.mochimap.com/issues',
      timestamp: date.toISOString()
    });
  }
};

module.exports = Responder;
