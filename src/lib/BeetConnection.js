import { v4 as uuidv4 } from 'uuid';
import * as OTPAuth from 'otpauth';

import { io } from "socket.io-client";

import sha256 from "crypto-js/sha256.js";
import aes from "crypto-js/aes.js";
import ENC from 'crypto-js/enc-utf8.js';
import * as ed from '@noble/ed25519';

class BeetConnection {

    constructor(appName, appHash, browser, origin, identity) {
      this.appName = appName; // Name/identifier of the app making use of this client
      this.appHash = appHash;
      this.browser = browser;
      this.origin = origin;
      this.identity = identity;

      this.id = null; // unused
      this.next_identification = null;

      this.connected = false; // State of WS Connection to Beet
      this.authenticated = false; // Whether this app has identified itself to Beet
      this.linked = false; // Whether this app has linked itself to a Beeteos account/id
      this.otp = null; // Holds the one-time-password generation for the linked account
      this.requests = []; // Holds pending API request promises to be resolved upon beeteos response
      this.socket = null;
    }

    /**
     * Reset current connection data if 3 concurrent errors occur
     */
    reset() {
        this.connected = false;
        this.authenticated = false;
        this.identity = null;
        this.linked = false;
        this.socket = null;
        this.otp = null;
        this.requests = [];
    }

    /**
     * Used to get the available id for a request and replace it with a new one while also returning its hash
     *
     * @returns {Object}
     */
    async fetch_ids() {
        if (this.connected && this.authenticated && this.linked) {
          let id = this.next_identification;
          let new_id = await uuidv4();
          this.next_identification = new_id;

          let next_hash = await sha256(new_id).toString();
          return {
              id: id,
              next_hash: next_hash.toString()
          };
        } else {
            throw new Error("You must be connected, authorised and linked.");
        }
    }

    /**
     * Sends a request to Beet.
     * If it is an API request, it is encrypted with a combination of:
     *   1. AES using a one-time-pass generated by the request id (as a counter)
     *   2. A previously established shared secret with Beeteos (using ECDH)
     *
     * @param {string} type Name of the call to execute
     * @param {object} payload
     * @returns {Promise} Resolving is done by Beet
     */
    async sendRequest(type, payload) {
        return new Promise(async (resolve, reject) => {
          if (!this.connected || !this.socket) {
            return reject('No beeteos ws connection.');
          }

          let request = {type: type};
          if (type == 'api') {
              let ids = await this.fetch_ids();
              payload.next_hash = ids.next_hash;
              request.id = ids.id;
              this.otp.counter = request.id;
              let key = this.otp.generate();
              request.payload = aes.encrypt(JSON.stringify(payload), key).toString();
          } else {
              request.id = await uuidv4();
              request.payload = payload;
          }
          
          console.log(`sending ${type} request`);
          this.requests.push(Object.assign(request, { resolve, reject }));
          this.socket.emit(type, request); // Message beeteos wallet
        });
    }

    /**
     * Set auth values outwith the socket class
     * @param {object} authToken
     */
    setAuth(authToken) {
      this.authenticated = authToken.payload.authenticate;
      this.linked = authToken.payload.link;
      if (!authToken.payload.link) {
        this.beetkey = authToken.payload.pub_key;
      }
    }

    /**
     * Connects to beeteos instance. If one of the existing linked identities (returned by init()) is passed, it also tries to enable that link
     * 
     * @param {Object} identity
     * @param {Boolean} ssl
     * @returns {Promise} Resolves to false if not connected after timeout, or to result of 'authenticate' beeteos call
     */
    async connect(identity = null, ssl = true, port) {
      return new Promise((resolve, reject) => {
        if (!identity) {
          this.reset();
        } else {
          this.identity = identity;
        }

        let socket;
        try {
          socket = ssl
                    ? io(`wss://local.get-beet.io:${port}/`, { secure: true, rejectUnauthorized: false })
                    : io(`ws://localhost:${port}`);
        } catch (error) {
          console.log(error);
          return reject(false);
        }

        /**
         * Successfully connected to the beeteos wallet
         */
        socket.on("connect", async () => {

            this.connected = true;
            console.log('received connected socket response');

            let payload = identity && identity.identityhash
                            ? {
                                origin: this.origin,
                                appName: this.appName,
                                browser: this.browser,
                                identityhash: identity.identityhash,
                              }
                            : {
                                origin: this.origin,
                                appName: this.appName,
                                browser: this.browser,
                              };
            
            let authReq = {
              type: 'authenticate',
              id: await uuidv4(),
              payload: payload
            };

            socket.emit('authenticate', authReq);
            
            socket.on('authenticated', (auth) => {
              console.log('socket: authenticated')
              if (auth.payload.link) {
                console.log(`authenticated: link`)
                this.otp = new OTPAuth.HOTP({
                    issuer: "Beet",
                    label: "BeetAuth",
                    algorithm: "SHA1",
                    digits: 32,
                    counter: 0,
                    secret: OTPAuth.Secret.fromHex(this.identity.secret)
                });
                this.identity = Object.assign(this.identity, auth.payload.requested);
              } else {
                this.beetkey = auth.payload.pub_key;
              }
              resolve(auth);
            }); // Message beeteos wallet
        });

        /**
         * Response to link request from beeteos wallet
         */
         socket.on("link", (linkRequest) => {
            const relevantRequest = this.requests.find((request) => {
              return request.id === linkRequest.id || request.id.toString() === linkRequest.id
            });

            if (!relevantRequest) {
              console.log(`Couldn't respond to link request`);
              return; // throw?
            }

            if (linkRequest.error) {
              console.log(`An error occurred during linking: ${linkRequest.payload.message}`)
              relevantRequest.reject(linkRequest);
            }

            this.linked = linkRequest.payload.link;
            this.authenticated = linkRequest.payload.authenticate;
            this.identity = linkRequest.payload.existing && this.identity
                              ? Object.assign(this.identity, linkRequest.payload.requested)
                              : {
                                  apphash: this.appHash,
                                  identityhash: linkRequest.payload.identityhash,
                                  chain: linkRequest.payload.chain,
                                  appName: this.appName,
                                  secret: this.secret,
                                  next_id: this.next_identification,
                                  requested: linkRequest.payload.requested,
                              };

            this.otp = new OTPAuth.HOTP({
                issuer: "Beet",
                label: "BeetAuth",
                algorithm: "SHA1",
                digits: 32,
                counter: 0,
                secret: OTPAuth.Secret.fromHex(this.secret)
            });

            relevantRequest.resolve(linkRequest); // resolve something else?
          });

          /**
           * Response to api request from beeteos wallet
           */
          socket.on("api", async (msg) => {
            console.log("socket.api"); // groupCollapsed

            const relevantRequest = this.requests.find((x) => {
              return x.id === msg.id || x.id.toString() === msg.id
            });

            if (!relevantRequest) {
              console.log(`No relevant requests`);
              return;
            }

            if (msg.error) {
              if (msg.payload.code == 2) {
                console.log("msg code 2: reset")
                this.reset();
              }
              relevantRequest.reject(msg.payload);
            }

            if (msg.encrypted) {
              this.otp.counter = msg.id;
              let key = this.otp.generate();
              let decryptedValue;
              try {
                decryptedValue = aes.decrypt(msg.payload, key).toString(ENC);
              } catch (error) {
                console.log(error);
                relevantRequest.reject(error);
              }
              relevantRequest.resolve(decryptedValue);
            } else {
              relevantRequest.resolve(msg.payload);
            }
          });

          socket.on("disconnect", async () => {
            this.connected = false;
            this.socket = null;
            this.requests = [];
            console.log("Websocket closed");
          });

          socket.on("reconnect_error", (error) => {
            console.log(`reconnect_error: ${error}`);
            if (this.socket) {
              this.socket.disconnect();
            }
          })

          socket.on("connect_error", async (error) => {
            console.log(`BeetConnection connect_error ${error}`);
            if (!this.socket) {
              console.log('no socket')
              return;
            }

            this.socket.disconnect();
          });

          this.socket = socket;
      });
    }


    /**
     * Requests to link to a beeteos account/id on specified chain
     *
     * @param {String} chain Symbol of the chain to be linked
     * @param {String} requestDetails Details to be requested from the user, defaults to account (id and name)
     * @returns {Object||Null}
     */
    async link(chain = 'ANY', requestDetails = ["account"]) {
      if (!this.connected) throw new Error("You must connect to beeteos first.");

      let linkObj = {
        chain: chain,
        request: requestDetails
      };

      let next_id;
      if (this.identity && this.identity.identityhash) {
        // Relinking
        console.log("RELINKING")
        next_id = this.identity.next_id;
        this.next_identification = next_id;
        this.secret = this.identity.secret;

      } else {
        // Linking
        if (!this.beetkey) {
          console.error("no beetkey");
          return;
        }

        const privk = ed.utils.randomPrivateKey();

        let secret;
        try {
          secret = await ed.getSharedSecret(privk, this.beetkey);
        } catch (error) {
          console.error(error);
          return;
        }

        this.secret = ed.utils.bytesToHex(secret);
        next_id = await uuidv4();

        let pubk;
        try {
          pubk = await ed.getPublicKey(privk);
        } catch (error) {
          console.error(error);
          return;
        }
        linkObj['pubkey'] = ed.utils.bytesToHex(pubk);  
      }

      this.next_identification = next_id;
      let next_hash;
      try {
        next_hash = await sha256(next_id).toString();
      } catch (error) {
        console.error(error);
        return;
      }

      linkObj['next_hash'] = next_hash;

      let sentRequest;
      try {
        if (this.identity && this.identity.identityhash) {
          console.log('sending relink request')
          sentRequest = await this.sendRequest('relinkRequest', {...linkObj, identityhash: this.identity.identityhash});
        } else {
          console.log('sending link request')
          sentRequest = await this.sendRequest('linkRequest', linkObj);
        }
      } catch (error) {
        console.debug(
          this.identity && this.identity.identityhash
            ? "link rejected"
            : "relink rejected",
          error
        );
        this.identity = null;
        return;
      }

      return sentRequest;
    }

    /*
     * Inject an external blockchain library into beeteos-js
     */
    inject(pointOfInjection, options = {sign: true, broadcast: true}) {
        if (this.identity.chain == "BTS" || this.identity.chain == "BTS_TEST" || this.identity.chain == "TUSC") {
            if (!!pointOfInjection.prototype && !!pointOfInjection.prototype.get_type_operation) {
                // transaction builder
                return this.injectTransactionBuilder(pointOfInjection, options);
            }
        } else if (this.identity.chain == "STEEM") {
            if (pointOfInjection.broadcast) {
                return this.injectSteemLib(pointOfInjection, options);
            }
        } else if (this.identity.chain == "BNB_TEST") {
            if (!!pointOfInjection.placeOrder) {
                return this.injectBinanceLib(pointOfInjection, options);
            }
        }
        throw new Error("Unsupported point of injection")
    }

    /**
     * Enable the user to inject the bitsharesjs library for advanced bitshares chain interaction
     *
     * @param {Module} TransactionBuilder
     * @param {object} options
     * @returns {Module}
     */
    injectTransactionBuilder(TransactionBuilder, options) {
        let sendRequest = this.sendRequest.bind(this);

        // if both options are set, we only want 1 beeteos call anyways
        if (options.sign && options.broadcast) {
            // forfeit private keys, and store public keys
            TransactionBuilder.prototype.add_signer = function add_signer(private_key, public_key) {
                if (typeof private_key !== "string" || !private_key || private_key !== "inject_wif") {
                    throw new Error("Do not inject wif while using Beet")
                }
                if (!this.signer_public_keys) {
                    this.signer_public_keys = [];
                }
                this.signer_public_keys.push(public_key);
            };
            TransactionBuilder.prototype.sign = function sign(chain_id = null) {
                // do nothing, wait for broadcast
                if (!this.tr_buffer) {
                    throw new Error("not finalized");
                }
                if (this.signed) {
                    throw new Error("already signed");
                }
                if (!this.signer_public_keys.length) {
                    throw new Error(
                        "Transaction was not signed. Do you have a private key? [no_signers]"
                    );
                }
                this.signed = true;
            };
            let send_to_beet = function sendToBeet(builder) {
                return new Promise((resolve, reject) => {
                    if (builder.operations.length != builder.operations.length) {
                        throw "Serialized and constructed operation count differs"
                    }
                    let args = ["signAndBroadcast", JSON.stringify(builder.toObject()), builder.signer_public_keys];
                    sendRequest('api', {
                        method: 'injectedCall',
                        params: args
                    }).then((result) => {
                        resolve(result);
                    }).catch((err) => {
                        reject(err);
                    });
                });
            };
            TransactionBuilder.prototype.broadcast = function broadcast(was_broadcast_callback) {
                return new Promise((resolve, reject) => {
                    // forward to beet
                    send_to_beet(this).then(
                        result => {
                            if (was_broadcast_callback) {
                                was_broadcast_callback();
                            }
                            resolve(result);
                        }
                    ).catch(err => {
                        reject(err);
                    });
                });
            }
        } else if (options.sign && !options.broadcast) {
            // forfeit private keys, and store public keys
            TransactionBuilder.prototype.add_signer = function add_signer(private_key, public_key) {
                if (typeof private_key !== "string" || !private_key || private_key !== "inject_wif") {
                    throw new Error("Do not inject wif while using Beet")
                }
                if (!this.signer_public_keys) {
                    this.signer_public_keys = [];
                }
                this.signer_public_keys.push(public_key);
            };
            TransactionBuilder.prototype.sign = function sign(chain_id = null) {
                return new Promise((resolve, reject) => {
                    let args = ["sign", JSON.stringify(this.toObject()), this.signer_public_keys];
                    sendRequest('api', {
                        method: 'injectedCall',
                        params: args
                    }).then((result) => {
                        // check that it's the same
                        console.log(result);
                        let tr = new TransactionBuilder(JSON.parse(result));
                        let sigs = tr.signatures;
                        tr.signatures = [];
                        if (JSON.stringify(tr) === JSON.stringify(this)) {
                            throw "Oh boy!"
                        }
                        this.signatures = sigs;
                        this.signer_private_keys = [];
                        this.signed = true;
                        resolve();
                    }).catch((err) => {
                        reject(err);
                    });
                });
            };
        } else if (!options.sign && options.broadcast) {
            throw "Unsupported injection"
        }
        return TransactionBuilder;
    }

    /* API Requests :

       The following should be split into chain-specific modules as multi-chain support is finalised
       These are currently BTS only.

    */

    /**
     * Gets the currently linked Bitshares account
     *
     * @returns {Promise} Resolving is done by Beet
     */
    getAccount() {
        if (!!this.identity.account) {
            return this.identity.account;
        } else {
            throw "This connection does not have access to account details";
        }
    }

    /**
     * Gets the currently linked Bitshares account from Beet
     *
     * @returns {JSON} Current account from beet
     */
    async requestAccount() {
        let account;
        try {
          account = await this.sendRequest('api', {
              method: 'getAccount',
              params: {}
          });
        } catch (error) {
          console.log(error);
          return;
        }

        return JSON.parse(account);
    }

    /**
     * Requests a signature for an arbitrary transaction
     *
     * @param {object} payload
     * @returns {Promise} Resolving is done by Beet
     */
    async requestSignature(payload) {
      let sigReq;
      try {
        sigReq = await this.sendRequest('api', {
            method: 'requestSignature',
            params: payload
        });
      } catch (error) {
        console.log(error);
        return;
      }
      return sigReq;
    }

    /**
     * Requests to execute a library call for the linked chain
     *
     * @param payload
     * @returns {Promise} Resolving is done by Beet
     */
    async injectedCall(payload) {
      let injectedCall;
      try {
        injectedCall = await this.sendRequest('api', {
            method: 'injectedCall',
            params: payload
        });
      } catch (error) {
        console.log(error)
        return;
      }

      return injectedCall;
    }

    /**
     * Request a signed message with the given text in the common beeteos format
     *
     * @param text
     * @returns {Promise} Resolving is done by Beet
     */
    async signMessage(text) {
      let message;
      try {
        message = await this.sendRequest('api', {
            method: 'signMessage',
            params: text
        });
      } catch (error) {
        console.log(error);
        return;
      }

      if (message) {
        return JSON.parse(message);
      }
    }

    /**
     * Sign an nft_object for NFTs on the Bitshares network
     *
     * @param {Object} nft_object
     * @returns {Promise} Resolving is done by Beet
     */
     async signNFT(nft_object) {
      let message;
      try {
        message = await this.sendRequest('api', {
            method: 'signNFT',
            params: JSON.stringify(nft_object)
        });
      } catch (error) {
        console.log(error);
        return;
      }

      if (message) {
        return JSON.parse(message);
      }
    }

    /**
     * Requests to verify a signed message with the given text in the common beeteos format
     *
     * @param text
     * @returns {Promise} Resolving is done by Beet
     */
    async verifyMessage(signedMessage) {
      let result;
      try {
        result = await this.sendRequest('api', {
            method: 'verifyMessage',
            params: signedMessage
        });
      } catch (error) {
        console.log(error);
        return;
      }

      return result;
    }
}

export default BeetConnection;
