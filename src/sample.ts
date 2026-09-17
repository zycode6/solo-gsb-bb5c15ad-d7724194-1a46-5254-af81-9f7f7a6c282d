const SAMPLE = `{"stream":"orders","sequence":1,"payload":{"id":"a","status":"created"}}
{"stream":"orders","sequence":1,"payload":{"id":"a","status":"created"}}
{"stream":"orders","sequence":2,"payload":{"id":"a","status":"paid"}}
{"stream":"orders","sequence":2,"payload":{"id":"a","status":"payment_failed"}}
{"stream":"orders","sequence":4,"payload":{"id":"a","status":"shipped"}}
{"stream":"payments","sequence":10,"payload":{"amount":100,"currency":"CNY"}}
{"stream":"payments","sequence":11,"payload":{"amount":100,"currency":"CNY"}}
{"stream":"payments","sequence":12,"payload":{"amount":100,"currency":"USD"}}`

export { SAMPLE }
