import { connect, link } from '../../src/index.js';
/**
 * @param {BeetConnection} connection
 * @param {string} targetAccount
 * @param {number} amountInSatoshi
 * @param {string} assetId
 */
async function transfer(connection, targetAccount, amountInSatoshi, assetId) {
  connection.transfer({
      to: targetAccount,
      amount: {
        satoshis: amountInSatoshi,
        asset_id: assetId
      }
  })
}

let run = async function () {
  let connection;
  try {
    connection = await connect(
      "App name",
      "Browser type",
      "localhost"
    );
  } catch (error) {
    console.error(error);
    return;
  }

  let linkAttempt;
  try {
    linkAttempt = await link("BTS", connection);
  } catch (error) {
    console.error(error)
    return;
  }

  if (connection.secret) {
    console.log('Successfully linked')
    transfer(connection, 'sschiessl', 1, '1.3.0')
  }
}

run();

