/* Headless Chrome runner for the QUnit suite in test/index.html.
 * Runs on a modern Node (18) with puppeteer-core; see test/ci/run-browser-tests.sh.
 * Usage: node test/ci/run-browser-tests.js <url>
 */
"use strict";

const puppeteer = require( "puppeteer-core" );

const url = process.argv[ 2 ] || "http://127.0.0.1:8000/test/index.html";
const DONE_TIMEOUT = 20 * 60 * 1000;

// Tests that cannot pass in current headless Chrome, keyed "<module> :: <test name>".
// Each depends on 2014-era browser behaviour, not on jQuery code paths.
const EXCLUDED_TESTS = {
	"ajax :: #14379 - jQuery.ajax() on unload":
		"Chrome 80+ disallows synchronous XHR during page dismissal (unload), so the request always errors",
	"offset :: fractions (see #7730 and #7885)":
		"modern Chrome LayoutNG snaps fractional offsets to 1/64 px (999.984375 instead of 1000)"
};

// Injected into every document before any page script runs.
function hookQUnit( excluded ) {
	// Only the top-level suite page reports results
	if ( window.top !== window ) {
		return;
	}

	window.__qunitResults = [];
	window.__qunitFailures = [];
	window.__qunitDone = null;

	let registered = false;

	function register( Q ) {
		if ( registered || !Q || typeof Q.log !== "function" ) {
			return false;
		}
		registered = true;

		let current = [];

		Q.log( function( d ) {
			if ( !d.result ) {
				current.push( {
					message: d.message,
					actual: d.actual,
					expected: d.expected,
					source: d.source
				} );
			}
		} );

		Q.testDone( function( d ) {
			window.__qunitResults.push( {
				module: d.module,
				name: d.name,
				failed: d.failed,
				passed: d.passed,
				total: d.total
			} );
			if ( d.failed > 0 ) {
				window.__qunitFailures.push( {
					module: d.module,
					name: d.name,
					assertions: current
				} );
			}
			current = [];
			console.log( ( d.failed > 0 ? "FAIL " : "PASS " ) + d.module + " :: " + d.name +
				" (" + d.passed + "/" + d.total + ")" );
		} );

		Q.moduleDone( function( d ) {
			console.log( "Module " + d.name + ": " + d.passed + " passed, " + d.failed + " failed" );
		} );

		Q.done( function( d ) {
			window.__qunitDone = {
				failed: d.failed,
				passed: d.passed,
				total: d.total,
				runtime: d.runtime
			};
		} );
		return true;
	}

	// Keep the excluded tests (see EXCLUDED_TESTS) from being registered at all,
	// and log each one so the exclusion is visible in the build log.
	window.__qunitExcluded = [];
	function excludeTests( Q ) {
		const original = Q.test;
		const filtered = function( testName ) {
			const module = Q.config && Q.config.currentModule;
			const reason = excluded[ module + " :: " + testName ];
			if ( reason ) {
				window.__qunitExcluded.push( module + " :: " + testName );
				console.log( "EXCLUDED " + module + " :: " + testName + " — " + reason );
				return;
			}
			return original.apply( this, arguments );
		};
		// asyncTest calls QUnit.test; testinit.js helpers call the global test()
		Q.test = filtered;
		window.test = filtered;
	}

	let stored;
	Object.defineProperty( window, "QUnit", {
		configurable: true,
		enumerable: true,
		get: function() {
			return stored;
		},
		set: function( value ) {
			stored = value;
			excludeTests( value );
			if ( !register( value ) ) {
				// Fallback: poll until the registration functions exist
				const timer = setInterval( function() {
					if ( register( stored ) ) {
						clearInterval( timer );
					}
				}, 1 );
			}
		}
	} );
}

function fmt( value ) {
	if ( value === undefined ) {
		return "undefined";
	}
	try {
		return JSON.stringify( value );
	} catch ( e ) {
		return String( value );
	}
}

( async function main() {
	let browser;
	let exitCode = 1;

	try {
		browser = await puppeteer.launch( {
			executablePath: process.env.CHROME_BIN,
			headless: "new",
			args: [ "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage" ]
		} );

		const page = await browser.newPage();
		page.setDefaultTimeout( DONE_TIMEOUT );
		await page.setViewport( { width: 1280, height: 1024 } );

		page.on( "console", function( msg ) {
			console.log( "[browser] " + msg.text() );
		} );
		page.on( "pageerror", function( err ) {
			console.log( "[pageerror] " + ( err && err.message ? err.message : err ) );
		} );

		await page.evaluateOnNewDocument( hookQUnit, EXCLUDED_TESTS );

		console.log( "Loading " + url );
		await page.goto( url, { waitUntil: "load", timeout: 120000 } );

		await page.waitForFunction( "window.__qunitDone !== null && window.__qunitDone !== undefined",
			{ polling: 1000, timeout: DONE_TIMEOUT } );

		const report = await page.evaluate( function() {
			return {
				done: window.__qunitDone,
				results: window.__qunitResults,
				failures: window.__qunitFailures,
				excluded: window.__qunitExcluded
			};
		} );

		if ( report.failures.length ) {
			console.log( "\nFailures:" );
			report.failures.forEach( function( f ) {
				console.log( "FAIL " + f.module + " :: " + f.name );
				f.assertions.forEach( function( a ) {
					console.log( "  message:  " + a.message );
					if ( a.actual !== undefined || a.expected !== undefined ) {
						console.log( "  actual:   " + fmt( a.actual ) );
						console.log( "  expected: " + fmt( a.expected ) );
					}
					if ( a.source ) {
						console.log( "  source:   " + a.source );
					}
				} );
			} );
		}

		const d = report.done;
		const testsFailed = report.results.filter( function( r ) {
			return r.failed > 0;
		} ).length;
		const testsTotal = report.results.length;

		console.log( "\nTests completed: " + d.total + " assertions, " + d.passed + " passed, " +
			d.failed + " failed; " + testsTotal + " tests (" + ( testsTotal - testsFailed ) +
			" passed, " + testsFailed + " failed), " + report.excluded.length +
			" excluded, in " + d.runtime + " ms" );

		exitCode = d.failed > 0 || testsFailed > 0 || testsTotal === 0 ? 1 : 0;
	} catch ( err ) {
		console.error( "Error running browser tests: " + ( err && err.stack ? err.stack : err ) );
		exitCode = 1;
	} finally {
		if ( browser ) {
			await browser.close().catch( function() {} );
		}
	}

	process.exit( exitCode );
}() );
