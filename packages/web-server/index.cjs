#!/usr/bin/env node
if (process.env.NODE_ENV == null) process.env.NODE_ENV = 'production'
// @ts-ignore
require(process.env.MULTI_USER === 'true' ? './server/accounts.js' : './server')
