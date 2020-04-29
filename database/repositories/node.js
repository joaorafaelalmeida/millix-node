import ntp from '../../core/ntp';
import console from '../../core/console';
import {Database} from '../database';
import async from 'async';

export default class Node {
    constructor(database) {
        this.database = database;
    }

    addNodeAttributeType(attributeType) {
        return new Promise(resolve => {
            let nodeAttributeID = Database.generateID(20);
            this.database.run('INSERT INTO node_attribute_type (attribute_type_id, attribute_type) VALUES (?, ?)',
                [
                    nodeAttributeID,
                    attributeType
                ], (err) => {
                    if (err) {
                        this.database.get('SELECT attribute_type_id FROM node_attribute_type WHERE attribute_type = ?',
                            [attributeType], (_, row) => {
                                resolve(row.attribute_type_id);
                            });
                        return;
                    }
                    resolve(nodeAttributeID);
                });
        });
    }

    getNodeAttribute(nodeID, attributeType) {
        return new Promise((resolve, reject) => {
            this.database.get('SELECT a.value FROM node_attribute a INNER JOIN node_attribute_type t on a.attribute_type_id = t.attribute_type_id WHERE t.attribute_type = ? AND a.node_id = ?',
                [
                    attributeType,
                    nodeID
                ], (err, row) => {
                    if (err || !row) {
                        return reject();
                    }
                    resolve(row.value);
                });
        });
    }

    addNodeAttribute(nodeID, attributeType, attributeValue) {
        return this.addNodeAttributeType(attributeType)
                   .then(attributeTypeID => {
                       this.database.run('INSERT OR REPLACE INTO node_attribute (node_id, attribute_type_id, value) VALUES (?,?,?)',
                           [
                               nodeID,
                               attributeTypeID,
                               attributeValue
                           ],
                           (err) => {
                               if (err) {
                                   throw Error(err.message);
                               }
                           });
                   });
    }

    eachNode(callback) {
        let sql = 'select * from node';
        this.database.each(sql, callback);
    }

    getNodes() {
        return new Promise(resolve => {
            this.database.all('select * from node', (err, rows) => {
                resolve(rows);
            });
        });
    }

    addNode(node) {
        let url = node.node_prefix + node.node_ip_address + ':' + node.node_port;
        return new Promise((resolve, reject) => {
            this.database.run('INSERT INTO node (node_prefix, node_ip_address, node_port, node_id) VALUES (?,?,?,?)', [
                node.node_prefix,
                node.node_ip_address,
                node.node_port,
                node.node_id
            ], (err) => {
                if (err) {
                    err.message.startsWith('SQLITE_CONSTRAINT') ? console.log(`[database] node ${url} already exits`) : console.error(err.message);
                    if (!node.node_id) {
                        return reject(err.message);
                    }
                    else {
                        this.database.run('UPDATE node SET node_id = ?, update_date = ? WHERE node_prefix = ? AND node_ip_address = ? AND node_port = ?', [
                            node.node_id,
                            Math.floor(ntp.now().getTime() / 1000),
                            node.node_prefix,
                            node.node_ip_address,
                            node.node_port
                        ], () => {
                            console.log(`[database] update node ${url} with id ${node.node_id}`);
                            return reject();
                        });
                        return;
                    }
                }
                resolve();
            });
        });
    }

    removeNode(node) {
        return new Promise((resolve, reject) => {
            let sql = 'delete from node where ip_address = ?';
            this.database.run(sql, [node.ip_address], (err) => {
                if (err) {
                    return reject(err.message);
                }
                resolve();
            });
        });
    }

}
