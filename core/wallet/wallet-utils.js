import Mnemonic from 'bitcore-mnemonic';
import Bitcore from 'bitcore-lib';
import crypto from 'crypto';
import config, {SHARD_ZERO_NAME} from '../config/config';
import fs from 'fs';
import path from 'path';
import base58 from 'bs58';
import os from 'os';
import {KJUR, KEYUTIL, X509, ASN1HEX} from 'jsrsasign';
import async from 'async';
import _ from 'lodash';
import database from '../../database/database';
import peer from '../../net/peer';
import ntp from '../ntp';
import objectHash from '../crypto/object-hash';
import network from '../../net/network';
import genesisConfig from '../genesis/genesis-config';
import signature from '../crypto/signature';
import node from '../../database/repositories/node';
import {v4 as uuidv4} from 'uuid';


class WalletUtils {
    constructor() {

    }

    // derives for wallet's private or public key
    deriveAddressFromKey(key, isChange, addressPosition) {
        const addressKeyPublicBuffer = this.derivePubkey(key, 'm/' + isChange + '/' + addressPosition);
        const address                = this.getAddressFromPublicKey(addressKeyPublicBuffer);
        const addressAttribute       = {key_public: base58.encode(addressKeyPublicBuffer)};
        return {
            address,
            address_attribute: addressAttribute
        };
    }

    getAddressFromPublicKey(addressKeyPublicBuffer) {
        const hash            = crypto.createHash('sha256').update(addressKeyPublicBuffer).digest();
        const encryptedPubKey = (config.MODE_TEST_NETWORK ? '6f' : '00') + crypto.createHash('ripemd160').update(hash).digest('hex');
        let checksum          = crypto.createHash('sha256').update(encryptedPubKey, 'hex').digest();
        checksum              = crypto.createHash('sha256').update(checksum).digest('hex').substring(0, 8);
        let hexAddress        = encryptedPubKey + checksum;
        return base58.encode(Buffer.from(hexAddress, 'hex'));
    }

    isValidAddress(address) {

        if (!config.MODE_TEST_NETWORK && !address.startsWith('1')) { // check if valid main net address
            return false;
        }
        else if (config.MODE_TEST_NETWORK && address.startsWith('1')) { // check if valid main testnet address
            return false;
        }

        let addressHex      = base58.decode(address).toString('hex');
        let addressChecksum = addressHex.substring(addressHex.length - 8);
        let encryptedPubKey = addressHex.substring(0, addressHex.length - 8);
        let checksum        = crypto.createHash('sha256').update(encryptedPubKey, 'hex').digest();
        checksum            = crypto.createHash('sha256').update(checksum).digest('hex').substring(0, 8);
        return checksum === addressChecksum;
    }

    derivePubkey(key, path) {
        const hdPubKey = new Bitcore.HDPublicKey(key);
        return hdPubKey.derive(path).publicKey.toBuffer();
    }

    deriveWalletFromKey(key) {
        const xPubKey = Bitcore.HDPublicKey(key).toString();
        const wallet  = crypto.createHash('sha256').update(xPubKey, 'utf8').digest('base64');
        return wallet;
    }

    deriveExtendedPrivateKey(xPrivKey, account) {
        return xPrivKey.derive(44, true).derive(0x1EE7, true).derive(account, true);
    }

    derivePrivateKey(extendedPrivateKey, isChange, addressPosition) {
        const privateKey = extendedPrivateKey.derive(isChange, false).derive(addressPosition, false).privateKey;
        return privateKey.toBuffer({size: 32});
    }

    newMnemonic() {
        let mnemonic = new Mnemonic(256); // generates new mnemonic
        while (!Mnemonic.isValid(mnemonic.toString())) {
            mnemonic = new Mnemonic(256);
        }
        return mnemonic;
    }

    loadMnemonic() {
        console.log(path.join(os.homedir(), config.WALLET_KEY_PATH));
        return new Promise((resolve, reject) => {
            fs.readFile(path.join(os.homedir(), config.WALLET_KEY_PATH), 'utf8', (err, data) => {
                if (err) {
                    return reject('Couldn\'t read wallet mnemonic');
                }

                const keys = JSON.parse(data);
                if (keys.mnemonic_phrase) {
                    return resolve([
                        keys.mnemonic_phrase,
                        keys.mnemonic_new === true
                    ]);
                }
                else {
                    return reject('Couldn\'t read nor create master key');
                }
            });
        });
    }

    storeMnemonic(mnemonic_phrase, mnemonic_new) {
        return new Promise((resolve, reject) => {
            const keys = {
                mnemonic_phrase,
                mnemonic_new
            };
            fs.writeFile(path.join(os.homedir(), config.WALLET_KEY_PATH), JSON.stringify(keys, null, '\t'), 'utf8', function(err) {
                if (err) {
                    return reject('failed to write keys file');
                }
                resolve(mnemonic_phrase);
            });
        });
    }

    getShardInfo(nodeID, shardDate, shardType, nodePrivateKey) {
        let baseShardInfo     = {
            node_id_origin: nodeID,
            shard_date    : shardDate,
            shard_type    : shardType
        };
        let shardInfo         = {
            ...baseShardInfo,
            node_signature: signature.sign(objectHash.getHashBuffer(baseShardInfo), nodePrivateKey.toBuffer())
        };
        shardInfo['shard_id'] = objectHash.getCHash288(shardInfo);
        return shardInfo;
    }

    removeMnemonic() {
        return new Promise(resolve => {
            fs.unlink(path.join(os.homedir(), config.WALLET_KEY_PATH), function() {
                resolve();
            });
        });
    }


    generateNodeKey() {
        const mnemonic = this.newMnemonic();
        return mnemonic.toHDPrivateKey(uuidv4());
    }

    getNodeIdFromCertificate(certificateData, type) {
        if (type === 'hex') {
            const certificate = new X509();
            certificate.readCertHex(certificateData);
            return this.getNodeIdFromCertificate(certificate);
        }
        else if (type === 'pem') {
            const certificate = new X509();
            certificate.readCertPEM(certificateData);
            return this.getNodeIdFromCertificate(certificate);
        }
        else {
            const certificate = certificateData;
            if (!certificate.verifySignature(certificate.getPublicKey()) ||
                !this._verifyTBSCertificate(certificate)) {
                throw Error('invalid node certificate');
            }

            const nodeIDInfo = certificate.getExtInfo('1.3.6.1.5.5.7.1.24.2');
            if (nodeIDInfo === undefined) {
                return null;
            }
            const nodeIDHex = ASN1HEX.getV(certificate.hex, nodeIDInfo.vidx);
            return Buffer.from(nodeIDHex, 'hex').toString('utf8');
        }
    }

    /**
     * get node id from the certificate
     * @param certificate
     * @return {boolean|boolean|undefined}
     */
    getNodePublicKeyFromCertificate(certificateData, type) {
        if (type === 'hex') {
            const certificate = new X509();
            certificate.readCertHex(certificateData);
            return this.getNodePublicKeyFromCertificate(certificate);
        }
        else if (type === 'pem') {
            const certificate = new X509();
            certificate.readCertPEM(certificateData);
            return this.getNodePublicKeyFromCertificate(certificate);
        }
        else {
            const certificate = certificateData;
            let nodePublicKey;
            try {
                let tbsHex      = ASN1HEX.getV(certificate.hex, 0, [0], '03');
                const idxExtSeq = ASN1HEX.getIdxbyList(tbsHex, 0, [
                    7,
                    0
                ], '30');

                const extIdxList = ASN1HEX.getChildIdx(tbsHex, idxExtSeq);

                if (extIdxList.length < 3) {
                    return false;
                }

                for (let i = 0; i < extIdxList.length - 1; i++) {
                    const idx = extIdxList[i];
                    const oid = ASN1HEX.hextooidstr(ASN1HEX.getVbyList(tbsHex, idx, [0], '06'));
                    if (oid === '1.3.6.1.5.5.7.1.24.1') {
                        const publicKeyBuffer = Buffer.from(ASN1HEX.getVbyList(tbsHex, idx, [
                            1,
                            0
                        ], '03', true), 'hex');
                        nodePublicKey         = base58.encode(publicKeyBuffer);
                        break;
                    }
                }

            }
            catch (e) {
            }
            return nodePublicKey;
        }
    }

    getNodeIdFromPublicKey(publicKey) {
        return this.getAddressFromPublicKey(base58.decode(publicKey));
    }

    isValidNodeIdentity(nodeID, publicKey, message, signature) {
        try {
            return this.verify(publicKey, signature, message) && (this.getNodeIdFromPublicKey(publicKey) === nodeID);
        }
        catch (e) {
            return false;
        }
    }

    signMessage(nodePrivateKey, message) {
        return signature.sign(objectHash.getHashBuffer(message), nodePrivateKey.toBuffer());
    }

    /**
     * verifies if the tbs certificate was associated to the @param nodeID
     * @param certificate
     * @param nodeID
     * @private
     * @return tbscertificate hex string
     */
    _verifyTBSCertificate(certificate) {
        try {
            let tbsHex       = ASN1HEX.getV(certificate.hex, 0, [0], '03');
            const tbsIdxList = ASN1HEX.getChildIdx(tbsHex, 0);

            const idxExtSeq = ASN1HEX.getIdxbyList(tbsHex, 0, [
                7,
                0
            ], '30');

            const extIdxList = ASN1HEX.getChildIdx(tbsHex, idxExtSeq);

            if (extIdxList.length < 3) {
                return false;
            }

            const lastExtensionIdx = extIdxList[extIdxList.length - 1];
            const oid              = ASN1HEX.hextooidstr(ASN1HEX.getVbyList(tbsHex, lastExtensionIdx, [0], '06'));
            if (oid !== '1.3.6.1.5.5.7.1.24.3') {
                return false;
            }
            let sign = ASN1HEX.getVbyList(tbsHex, lastExtensionIdx, [
                1,
                0
            ], '03', true);
            sign     = base58.encode(Buffer.from(sign, 'hex'));

            const extensionsArray = [];
            let publicKeyBuffer, nodeID;
            for (let i = 0; i < extIdxList.length - 1; i++) {
                const idx    = extIdxList[i];
                const extTLV = ASN1HEX.getTLV(tbsHex, idx);
                extensionsArray.push({getEncodedHex: () => extTLV});

                const oid = ASN1HEX.hextooidstr(ASN1HEX.getVbyList(tbsHex, idx, [0], '06'));
                if (oid === '1.3.6.1.5.5.7.1.24.1') {
                    publicKeyBuffer = Buffer.from(ASN1HEX.getVbyList(tbsHex, idx, [
                        1,
                        0
                    ], '03', true), 'hex');
                }
                else if (oid === '1.3.6.1.5.5.7.1.24.2') {
                    nodeID = Buffer.from(ASN1HEX.getVbyList(tbsHex, idx, [
                        1,
                        0
                    ], '0c'), 'hex').toString();
                }
            }
            const extSeq    = new KJUR.asn1.DERSequence({'array': extensionsArray});
            const extTagObj = new KJUR.asn1.DERTaggedObject({
                'explicit': true,
                'tag'     : 'a3',
                'obj'     : extSeq
            });

            const tbsCertificateArray = [];
            for (let i = 0; i < tbsIdxList.length - 1; i++) {
                const idx        = tbsIdxList[i];
                const tbsItemTLV = ASN1HEX.getTLV(tbsHex, idx);
                tbsCertificateArray.push({getEncodedHex: () => tbsItemTLV});
            }
            tbsCertificateArray.push(extTagObj);

            tbsHex     = new KJUR.asn1.DERSequence({'array': tbsCertificateArray}).getEncodedHex();
            const hash = objectHash.getHashBuffer(Buffer.from(tbsHex, 'hex'), true);
            return signature.verify(hash, sign, base58.encode(publicKeyBuffer)) && this.getAddressFromPublicKey(publicKeyBuffer) === nodeID;
        }
        catch (e) {
            return false;
        }
    }

    _getCertificateExtension(oid, valueHex) {
        const extension           = new KJUR.asn1.x509.Extension();
        extension.oid             = oid;
        extension.getExtnValueHex = () => valueHex;
        return extension;
    }

    loadNodeKeyAndCertificate() {
        return new Promise((resolve, reject) => {
            const elements = [
                {
                    file       : path.join(os.homedir(), config.NODE_CERTIFICATE_KEY_PATH),
                    transformer: KEYUTIL.getKey,
                    key        : 'certificate_private_key'
                },
                {
                    file       : path.join(os.homedir(), config.NODE_KEY_PATH),
                    transformer: (data) => new Bitcore.HDPrivateKey(data),
                    key        : 'node'
                },
                {
                    file       : path.join(os.homedir(), config.NODE_CERTIFICATE_PATH),
                    transformer: (pem) => {
                        const x509 = new X509();
                        x509.readCertPEM(pem);
                        return x509;
                    },
                    key        : 'certificate'
                }
            ];
            async.mapSeries(elements, (element, callback) => {
                fs.readFile(element.file, 'utf8', function(err, pemData) {
                    if (err) {
                        return callback(true);
                    }
                    try {
                        if (element.key === 'node') {
                            const data = JSON.parse(pemData);
                            if (data.key) {
                                const obj = element.transformer(data.key);
                                return callback(false, {
                                    [element.key + '_private_key']: obj.privateKey,
                                    [element.key + '_public_key'] : obj.publicKey
                                });
                            }
                            else {
                                return callback(true);
                            }
                        }
                        else {
                            const obj = element.transformer(pemData);
                            return callback(false, {
                                [element.key]         : obj,
                                [element.key + '_pem']: pemData
                            });
                        }
                    }
                    catch (e) {
                        return callback(true);
                    }
                });
            }, (error, data) => {
                if (!error) {
                    return resolve(_.reduce(data, (obj, item) => ({...obj, ...item})));
                }
                else {
                    const ecKeypair = KEYUTIL.generateKeypair('EC', 'secp256r1');

                    // generate TBSCertificate
                    const tbsc = new KJUR.asn1.x509.TBSCertificate();

                    // add basic fields
                    tbsc.setSerialNumberByParam({'int': Date.now()});
                    tbsc.setSignatureAlgByParam({'name': 'SHA1withECDSA'});
                    tbsc.setIssuerByParam({'str': '/C=US/O=millix foundation/CN=mlx/ST=millix network'});
                    tbsc.setNotBeforeByParam({'str': '200504235959Z'});
                    tbsc.setNotAfterByParam({'str': '300504235959Z'});
                    tbsc.setSubjectByParam({'str': '/C=US/O=millix foundation/CN=mlx/ST=millix network'});
                    tbsc.setSubjectPublicKeyByGetKey(ecKeypair.pubKeyObj);
                    // add extensions
                    tbsc.appendExtension(new KJUR.asn1.x509.BasicConstraints({'cA': true}));
                    const subjectKeyIdentifierHex = KJUR.crypto.Util.hashHex(ecKeypair.pubKeyObj.pubKeyHex, 'sha1');
                    tbsc.appendExtension(new KJUR.asn1.x509.SubjectKeyIdentifier({kid: {hex: subjectKeyIdentifierHex}}));
                    tbsc.appendExtension(new KJUR.asn1.x509.AuthorityKeyIdentifier({kid: {hex: subjectKeyIdentifierHex}}));
                    this.loadOrCreateNodeKey().then(nodeKey => {
                        const nodePublicKeyHex = nodeKey.publicKey.toString();
                        const nodeID           = this.getAddressFromPublicKey(nodeKey.publicKey.toBuffer());
                        tbsc.appendExtension(this._getCertificateExtension('1.3.6.1.5.5.7.1.24.1', KJUR.asn1.ASN1Util.newObject({'bitstr': '04' + nodePublicKeyHex}).getEncodedHex()));
                        tbsc.appendExtension(this._getCertificateExtension('1.3.6.1.5.5.7.1.24.2', KJUR.asn1.ASN1Util.newObject({'utf8str': nodeID}).getEncodedHex()));
                        const tbscNodeSignatureHex = signature.sign(objectHash.getHashBuffer(Buffer.from(tbsc.getEncodedHex(), 'hex'), true), nodeKey.privateKey.toBuffer(), 'hex');
                        tbsc.appendExtension(this._getCertificateExtension('1.3.6.1.5.5.7.1.24.3', KJUR.asn1.ASN1Util.newObject({'bitstr': '04' + tbscNodeSignatureHex}).getEncodedHex()));

                        // sign and get PEM certificate with CA private key
                        const certificate = new KJUR.asn1.x509.Certificate({
                            'tbscertobj': tbsc,
                            'prvkeyobj' : ecKeypair.prvKeyObj
                        });
                        certificate.sign();
                        const certificatePem = certificate.getPEMString();

                        const privateKeyPem = KEYUTIL.getPEM(ecKeypair.prvKeyObj, 'PKCS1PRV');

                        fs.writeFile(path.join(os.homedir(), config.NODE_CERTIFICATE_KEY_PATH), privateKeyPem, 'utf8', function(err) {
                            if (err) {
                                return reject('failed to write node private key file');
                            }
                            fs.writeFile(path.join(os.homedir(), config.NODE_CERTIFICATE_PATH), certificatePem, 'utf8', function(err) {
                                if (err) {
                                    return reject('failed to write node certificate file');
                                }
                                resolve({
                                    certificate_private_key    : ecKeypair.prvKeyObj,
                                    certificate_private_key_pem: privateKeyPem,
                                    certificate                : certificate,
                                    certificate_pem            : certificatePem,
                                    node_private_key           : nodeKey.privateKey,
                                    node_public_key            : nodeKey.publicKey
                                });
                            });
                        });
                    }).catch(() => reject('failed to create node id file'));
                }
            });
        });
    }

    loadOrCreateNodeKey() {
        return new Promise((resolve, reject) => {
            this.loadNodeKey()
                .then(nodeKey => resolve(nodeKey))
                .catch(() => {
                    const nodeKey = this.generateNodeKey();
                    this.storeNodeKey(nodeKey)
                        .then(() => resolve(nodeKey))
                        .catch(() => reject());
                });
        });
    }

    loadNodeKey() {
        return new Promise((resolve, reject) => {
            fs.readFile(path.join(os.homedir(), config.NODE_KEY_PATH), 'utf8', function(err, data) {
                if (err) {
                    return reject('couldn\'t read node key');
                }

                data = JSON.parse(data);
                if (data.key) {
                    return resolve(new Bitcore.HDPrivateKey(data.key));
                }
                else {
                    return reject('couldn\'t read node key');
                }
            });
        });
    }

    storeNodeKey(key) {
        return new Promise((resolve, reject) => {
            fs.writeFile(path.join(os.homedir(), config.NODE_KEY_PATH), JSON.stringify({key: key.toString()}, null, '\t'), 'utf8', function(err) {
                if (err) {
                    return reject('failed to write node key file');
                }
                resolve(key);
            });
        });
    }

    storeNodeData(extraData) {
        return new Promise((resolve, reject) => {
            fs.readFile(path.join(os.homedir(), config.NODE_KEY_PATH), 'utf8', function(err, data) {
                if (err) {
                    return reject('couldn\'t the node data file');
                }

                data = {...JSON.parse(data), ...extraData};

                fs.writeFile(path.join(os.homedir(), config.NODE_KEY_PATH), JSON.stringify(data, null, '\t'), 'utf8', function(err) {
                    if (err) {
                        return reject('failed to write to the node data file');
                    }
                    resolve();
                });

            });
        });
    }

    verifyTransaction(transaction) {
        return new Promise(resolve => {
            if (transaction.transaction_id === genesisConfig.genesis_transaction) {
                return resolve(true);
            }
            if (!this.isValidTransactionObject(transaction)) {
                return resolve(false);
            }
            else {
                return resolve(true);
            }
        });
    }

    verify(publicKey, sign, message) {
        return signature.verify(objectHash.getHashBuffer(message), sign, publicKey);
    }

    isValidTransactionObject(transaction) {
        //sort arrays
        transaction['transaction_output_list'] = _.sortBy(transaction.transaction_output_list, 'output_position');
        transaction['transaction_input_list']  = _.sortBy(transaction.transaction_input_list, 'input_position');
        //verify addresses
        if (transaction.transaction_id !== genesisConfig.genesis_transaction) {
            for (let i = 0; i < transaction.transaction_input_list.length; i++) {
                if (!this.isValidAddress(transaction.transaction_input_list[i].address_base)
                    || !this.isValidAddress(transaction.transaction_input_list[i].address_key_identifier)) {
                    return false;
                }
            }
        }

        for (let i = 0; i < transaction.transaction_output_list.length; i++) {
            if (!this.isValidAddress(transaction.transaction_output_list[i].address_base)
                || !this.isValidAddress(transaction.transaction_output_list[i].address_key_identifier)) {
                return false;
            }

            try {
                let amount = Math.round(transaction.transaction_output_list[i].amount);
                if (amount <= 0 || amount !== transaction.transaction_output_list[i].amount) {
                    return false;
                }
            }
            catch (e) {
                return false;
            }
        }

        for (let i = 0; i < transaction.transaction_signature_list.length; i++) {
            if (!this.isValidAddress(transaction.transaction_signature_list[i].address_base)) {
                return false;
            }
        }


        // genesis transaction
        if (transaction.transaction_id === genesisConfig.genesis_transaction) {
            transaction['transaction_input_list']  = [
                {
                    type          : 'issue',
                    amount        : config.MILLIX_CIRCULATION,
                    input_position: 0
                }
            ];
            transaction['transaction_parent_list'] = [];
        }

        // verify signature
        let vTransaction = _.cloneDeep(_.omit(transaction, [
            'payload_hash',
            'transaction_id',
            'transaction_date',
            'node_id_origin',
            'shard_id',
            'version'
        ]));
        const sign       = vTransaction.transaction_signature_list[0]['signature'];
        delete vTransaction.transaction_signature_list[0]['signature'];
        if (transaction.transaction_id === genesisConfig.genesis_transaction) {
            delete vTransaction['transaction_parent_list'];
        }
        vTransaction['payload_hash']                            = objectHash.getCHash288(vTransaction);
        vTransaction['transaction_date']                        = transaction.transaction_date;
        vTransaction['node_id_origin']                          = transaction.node_id_origin;
        vTransaction['shard_id']                                = transaction.shard_id;
        vTransaction['version']                                 = transaction.version;
        const signatureVerified                                 = this.verify(vTransaction.transaction_signature_list[0].address_attribute.key_public, sign, vTransaction);
        vTransaction.transaction_signature_list[0]['signature'] = sign;
        vTransaction['transaction_id']                          = objectHash.getCHash288(vTransaction);
        return !(signatureVerified === false || vTransaction['payload_hash'] !== transaction['payload_hash'] || vTransaction['transaction_id'] !== transaction['transaction_id']);
    }


    signTransaction(inputList, outputList, privateKeyMap) {
        if (!inputList || inputList.length === 0) {
            return Promise.reject('input list is required');
        }

        if (!outputList || outputList.length === 0) {
            return Promise.reject('output list is required');
        }

        if (!privateKeyMap) {
            return Promise.reject('private key set is required');
        }

        const addressRepository = database.getRepository('address');
        const keychainRepository = database.getRepository('keychain');
        return new Promise((resolve, reject) => {
            let allocatedFunds = 0;
            const amount       = _.sum(_.map(outputList, o => o.amount));
            async.eachSeries(inputList, (input, callback) => {
                database.firstShards((shardID) => {
                    const transactionRepository = database.getRepository('transaction', shardID);
                    return transactionRepository.getTransactionOutput({
                        transaction_id : input.output_transaction_id,
                        output_position: input.output_position
                    });
                }).then(output => {
                    allocatedFunds += output.amount;
                    callback();
                }).catch(() => {
                    callback(`output_not_found: ${JSON.stringify(input)}`);
                });
            }, (err) => {
                if (err) {
                    return reject(err);
                }
                else if (amount !== allocatedFunds) {
                    return reject(`invalid_amount: allocated (${allocatedFunds}), spend (${amount})`);
                }
                resolve();
            });
        }).then(() => new Promise((resolve, reject) => {
            const addressBaseList = _.uniq(_.map(inputList, i => i.address_base));
            const signatureList   = [];
            async.eachSeries(addressBaseList, (addressBase, callback) => {
                keychainRepository.getKeychainAddressBaseAttribute(addressBase)
                                 .then(attribute => {
                                     signatureList.push({
                                         address_base     : addressBase,
                                         address_attribute: attribute.address_attribute
                                     });
                                     callback();
                                 })
                                 .catch(() => {
                                     callback('address_attribute_not_found: ' + addressBase);
                                 });
            }, (err) => {
                if (err) {
                    return reject(err);
                }
                return resolve(signatureList);
            });
        }))
          .then((signatureList) => peer.getNodeAddress()
                                       .then(({ip_address: nodeIPAddress}) => ntp.getTime().then(time => [
                                           signatureList,
                                           nodeIPAddress,
                                           new Date(Math.floor(time.now.getTime() / 1000) * 1000)
                                       ])))
          .then(([signatureList, nodeIPAddress, timeNow]) => {

              let transaction = {
                  transaction_input_list    : _.map(inputList, o => _.pick(o, [
                      'output_transaction_id',
                      'output_position',
                      'output_transaction_date',
                      'output_shard_id',
                      'address_base',
                      'address_version',
                      'address_key_identifier'
                  ])),
                  transaction_output_list   : _.map(outputList, o => _.pick(o, [
                      'address_base',
                      'address_version',
                      'address_key_identifier',
                      'amount'
                  ])),
                  transaction_signature_list: signatureList
              };

              return database.firstShards((shardID) => {
                  const transactionRepository = database.getRepository('transaction', shardID);
                  return new Promise((resolve, reject) => transactionRepository.getFreeTransactions()
                                                                               .then(parents => parents.length ? resolve(parents) : reject()));
              }).then(parents => {
                  if (!parents) {
                      throw Error('parent_transaction_not_available');
                  }

                  transaction['transaction_parent_list'] = _.map(parents, p => p.transaction_id).sort();
                  return [
                      transaction,
                      timeNow,
                      nodeIPAddress
                  ];
              });
          })
          .then(([transaction, timeNow]) => {
              transaction.transaction_input_list.forEach((input, idx) => input['input_position'] = idx);
              transaction.transaction_output_list.forEach((output, idx) => output['output_position'] = idx);
              transaction['payload_hash']     = objectHash.getCHash288(transaction);
              transaction['transaction_date'] = timeNow.toISOString();
              transaction['node_id_origin']   = network.nodeID;
              transaction['shard_id']         = _.sample(_.filter(_.keys(database.shards), shardID => shardID !== SHARD_ZERO_NAME));
              transaction['version']          = config.WALLET_TRANSACTION_DEFAULT_VERSION;
              for (let transactionSignature of transaction.transaction_signature_list) {
                  const privateKeyHex = privateKeyMap[transactionSignature.address_base];
                  if (!privateKeyHex) {
                      return Promise.reject(`private_key_not_found: address<${transactionSignature.address_base}>`);
                  }
                  try {
                      const privateKeyBuf               = Buffer.from(privateKeyHex, 'hex');
                      transactionSignature['signature'] = signature.sign(objectHash.getHashBuffer(transaction), privateKeyBuf);
                  }
                  catch (e) {
                      return Promise.reject(`sign_error: address<${transactionSignature.address_base}>`);
                  }
              }
              transaction['transaction_id'] = objectHash.getCHash288(transaction);
              return transaction;
          });
    }
}


export default new WalletUtils();
