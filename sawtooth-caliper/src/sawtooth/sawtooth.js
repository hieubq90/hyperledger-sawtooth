/**
 * Copyright 2017 HUAWEI All Rights Reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * @file, definition of the Sawtooth class, which implements the caliper's NBI for hyperledger sawtooth lake
 */

"use strict";
var fs = require("fs");
var BlockchainInterface = require("../comm/blockchain-interface.js");
const {
	calculateAddress,
	calculateAddresses
} = require("../../lib/sawtooth/address");
const Cargo = require("../../lib/cargo");
const request = require("request-promise");
const cbor = require("cbor");
const { createHash } = require("crypto");
const { protobuf } = require("sawtooth-sdk");
const { createContext, CryptoFactory } = require("sawtooth-sdk/signing");

class Sawtooth extends BlockchainInterface {
	constructor(config) {
		super(config);

		const cryptoContext = createContext("secp256k1");
		const privateKey = cryptoContext.newRandomPrivateKey();
		this.signer = new CryptoFactory(cryptoContext).newSigner(privateKey);

		this.cargo = new Cargo(
			(tasks, callback) => {
				const batchBytes = createBatch(this.signer, tasks);

				callback(
					submitBatches(batchBytes, this.config.sawtooth.network.restapi.url)
				);
			},
			100,
			1000
		);
	}

	gettype() {
		return "sawtooth";
	}

	init() {
		// todo: sawtooth
		// we just start the network

		return Promise.resolve();
	}

	installSmartContract() {
		// todo:
		// we just run the processor
		return Promise.resolve();
	}

	getContext(name, args) {
		return Promise.resolve();
	}

	releaseContext(context) {
		// todo:
		return Promise.resolve();
	}

	invokeSmartContract(context, contractID, contractVer, args, timeout) {
		// const address = calculateAddresses(contractID, args);

		// const batchBytes = createBatch(
		// 	this.signer,
		// 	contractID,
		// 	contractVer,
		// 	address,
		// 	args
		// );
		// // console.log(contractID, sawtoothContractVersion, address, args);
		// return submitBatches(batchBytes, this.config.sawtooth.network.restapi.url);

		return new Promise(resolve => {
			this.cargo.push(
				{
					contractID: contractID,
					contractVer: contractVer,
					args: args
				},
				resolve
			);
		});
	}

	queryState(context, contractID, contractVer, queryName) {
		return querybycontext(
			context,
			contractID,
			contractVer,
			queryName,
			this.config.sawtooth.network.restapi.url
		);
	}

	getDefaultTxStats(stats, results) {
		// nothing to do now
	}
}

module.exports = Sawtooth;

// const restApiUrl = "http://127.0.0.1:8080";

function querybycontext(context, contractID, contractVer, name, restApiUrl) {
	const address = calculateAddress(contractID, name);
	return getState(address, restApiUrl);
}

function getState(address, restApiUrl) {
	var invoke_status = {
		status: "created",
		time_create: Date.now(),
		time_final: 0,
		result: null
	};

	const stateLink = restApiUrl + "/state/" + address;
	var options = {
		uri: stateLink,
		json: true
	};

	return request(options)
		.then(function(body) {
			// console.log("Get Body from state: " + body);
			let data = body.data;

			if (data) {
				let stateDataBuffer = Buffer.from(data, "base64");
				let stateData = stateDataBuffer.toString();
				invoke_status.time_final = Date.now();
				invoke_status.result = stateData;
				invoke_status.status = "success";
				return Promise.resolve(invoke_status);
			} else {
				throw new Error("no query responses");
			}
		})
		.catch(function(err) {
			console.log("Query failed, " + (err.stack ? err.stack : err));
			return Promise.resolve(invoke_status);
		});
}

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function submitBatches(batchBytes, restApiUrl) {
	var invoke_status = {
		id: 0,
		status: "created",
		time_create: Date.now(),
		time_final: 0,
		time_endorse: 0,
		time_order: 0,
		result: null
	};

	var options = {
		method: "POST",
		url: restApiUrl + "/batches",
		body: batchBytes,
		headers: { "Content-Type": "application/octet-stream" }
	};
	return request(options)
		.then(function(body) {
			// console.log("Got Body: " + body);
			let link = JSON.parse(body).link;
			return getBatchStatus(link, invoke_status);
		})
		.catch(function(err) {
			console.log("Submit batches failed, " + (err.stack ? err.stack : err));
			return Promise.resolve(invoke_status);
		});
}

var getIndex = 0;
function getBatchStatus(link, invoke_status) {
	getIndex++;
	let statusLink = link;
	var intervalID = 0;
	var timeoutID = 0;

	var repeat = (ms, invoke_status) => {
		return new Promise(resolve => {
			intervalID = setInterval(function() {
				return getBatchStatusByRequest(
					resolve,
					statusLink,
					invoke_status,
					intervalID,
					timeoutID
				);
			}, ms);
		});
	};

	var timeout = (ms, invoke_status) => {
		return new Promise(resolve => {
			timeoutID = setTimeout(function() {
				clearInterval(intervalID);
				return resolve(invoke_status);
			}, ms);
		});
	};

	return Promise.race([
		repeat(500, invoke_status),
		timeout(30000, invoke_status)
	])
		.then(function() {
			return Promise.resolve(invoke_status);
		})
		.catch(function(error) {
			console.log("getBatchStatus error: " + error);
			return Promise.resolve(invoke_status);
		});
}

var timeoutID = 0;
var requestIndex = 0;

function getBatchStatusByRequest(
	resolve,
	statusLink,
	invoke_status,
	intervalID,
	timeoutID
) {
	requestIndex++;
	var options = {
		uri: statusLink,
		json: true
	};
	return request(options)
		.then(function(body) {
			let batchStatuses = body.data;
			// console.log("Got Status: " + JSON.stringify(batchStatuses));
			let hasPending = false;
			for (let index in batchStatuses) {
				let batchStatus = batchStatuses[index].status;
				if (batchStatus == "PENDING") {
					hasPending = true;
					break;
				}
			}
			if (hasPending != true) {
				invoke_status.status = "success";
				invoke_status.time_final = Date.now();
				clearInterval(intervalID);
				clearTimeout(timeoutID);
				return resolve(invoke_status);
			}
		})
		.catch(function(err) {
			// console.log(err);
			return resolve(invoke_status);
		});
}

function createTransaction(signer, contractID, contractVer, data) {
	const payloadBytes = cbor.encode(data);
	const addresses = calculateAddresses(contractID, data);
	const transactionHeaderBytes = protobuf.TransactionHeader.encode({
		familyName: contractID,
		familyVersion: contractVer,
		inputs: addresses,
		outputs: addresses,
		signerPublicKey: signer.getPublicKey().asHex(),
		// In this example, we're signing the batch with the same private key,
		// but the batch can be signed by another party, in which case, the
		// public key will need to be associated with that key.
		batcherPublicKey: signer.getPublicKey().asHex(),
		// In this example, there are no dependencies.  This list should include
		// an previous transaction header signatures that must be applied for
		// this transaction to successfully commit.
		// For example,
		// dependencies: ['540a6803971d1880ec73a96cb97815a95d374cbad5d865925e5aa0432fcf1931539afe10310c122c5eaae15df61236079abbf4f258889359c4d175516934484a'],
		dependencies: [],
		payloadSha512: createHash("sha512")
			.update(payloadBytes)
			.digest("hex")
	}).finish();

	const transaction = protobuf.Transaction.create({
		header: transactionHeaderBytes,
		headerSignature: signer.sign(transactionHeaderBytes),
		payload: payloadBytes
	});

	return transaction;
}

function createBatch(signer, tasks) {
	const transactions = tasks.map(task =>
		createTransaction(signer, task.contractID, task.contractVer, task.args)
	);

	const batchHeaderBytes = protobuf.BatchHeader.encode({
		signerPublicKey: signer.getPublicKey().asHex(),
		transactionIds: transactions.map(txn => txn.headerSignature)
	}).finish();

	const batch = protobuf.Batch.create({
		header: batchHeaderBytes,
		headerSignature: signer.sign(batchHeaderBytes),
		transactions: transactions
	});

	const batchListBytes = protobuf.BatchList.encode({
		batches: [batch]
	}).finish();

	return batchListBytes;
}