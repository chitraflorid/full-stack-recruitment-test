const _ = require('lodash');
const fetch = require('node-fetch');
const querystring = require('querystring');

const config = require('./config');

const pricingUrl = `${config.skyscannerApi}apiservices/pricing/v1.0`;

const maxRetries = 3;
const maxPollTime = 15 * 1000;
const pollDelay = 1000;

let cachedData = {};

const sessionParams = query => querystring.stringify({
  apiKey: config.apiKey,
  adults: query.adults,
  cabinclass: query.class,
  country: 'UK',
  currency: 'GBP',
  destinationplace: query.toPlace,
  inbounddate: query.toDate,
  locale: 'en-GB',
  locationschema: 'Sky',
  originplace: query.fromPlace,
  outbounddate: query.fromDate,
});

/**
  Rough implementation of live pricing api client, as per
  https://skyscanner.github.io/slate/#api-documentation
*/
const livePricing = {
  api: {
    createSession: params => fetch(`${pricingUrl}?apikey=${config.apiKey}`, {
      method: 'POST',
      body: sessionParams(params),
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }),
    pollSession: creds => fetch(`${pricingUrl}/${creds.sessionKey}?apiKey=${config.apiKey}`, {
      method: 'GET',
    }),
  },
};

const createSession = (params) => {
  console.log('creating session...');

  return new Promise((resolve, reject) => {
    livePricing.api.createSession(params)
      .then((response) => {
        if (response.status !== 201) {
          console.error(response.status, 'something went wrong...');

          return response.json().then(console.error);
        }

        // session created
        _.delay(() => resolve({
          location: response.headers.get('location'),
          response: response.json(),
        }), pollDelay);
      })
      .catch(reject);
  });
};

const pollSuccess = (state, data) => {
  if (state.finished) {
    return;
  }

  if (data.Status === 'UpdatesComplete' || state.timedOut) {
    console.log('polling complete');
    state.finished = true;
    return state.onFinished(data);
  }
  state.repoll();
};

// Not implemented: error handling by response code
const pollError = (state, err) => {
  state.tries++;
  if (!state.timedOut && state.tries < maxRetries) {
    return state.repoll();
  }
  state.onError(err);
};

const poll = (state) => {
  if (state.finished) {
    return;
  }

  // auto-repoll if nothing happens for a while
  const backupTimer = setTimeout(() => {
    state.repoll();
  }, pollDelay * 3);

  console.log('polling...');

  livePricing.api.pollSession(state.creds)
    .then((response) => {
      clearTimeout(backupTimer);

      if (response.status === 304) {
        return cachedData;
      }
      return response.json();
    })
    .then((data) => {
      cachedData = data;
      state.success(data);
    })
    .catch(state.err);
};

const startPolling = (session) => {
  const { location } = session;
  const sessionKey = location.substring(location.lastIndexOf('/') + 1);

  console.log('session created.');

  return new Promise((resolve, reject) => {
    // encapsulation of polling state to pass around
    const pollState = {
      creds: { sessionKey },
      finished: false,
      onFinished: resolve,
      onError: reject,
      timedOut: false,
      tries: 0,
    };

    pollState.success = _.partial(pollSuccess, pollState);
    pollState.error = _.partial(pollError, pollState);

    pollState.repoll = () => {
      _.delay(() => {
        poll(pollState);
      }, pollDelay);
    };

    // overall timeout - don't wait too long for complete results
    setTimeout(() => {
      pollState.timedOut = true;
    }, maxPollTime);

    poll(pollState);
  });
};

livePricing.search = searchParams => new Promise((resolve, reject) => {
  createSession(searchParams)
    .then(startPolling)
    .then(resolve)
    .catch(reject);
});

module.exports = livePricing;
