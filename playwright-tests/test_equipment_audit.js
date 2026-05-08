#!/usr/bin/env node
'use strict';

process.env.QT_URL = 'https://ipdev.quickflow.in/login';
process.env.QT_MASTER = 'Equipment-Name-Master';
process.env.QT_OP = 'create';
process.env.QT_HEADLESS = 'true';
process.env.QT_VERIFY_AUDIT = 'true';

require('./crud-master.js');
