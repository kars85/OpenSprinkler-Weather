import * as express from "express";
import * as fs from "fs";
import { GeoCoordinates } from "../types";
import { getParameter, resolveCoordinates } from "./weather"; // Assuming these are correctly exported from weather.ts

const DATA_FILE = __dirname + "/../../baselineEToData/Baseline_ETo_Data.bin";
let FILE_META: FileMeta | undefined; // Allow undefined initially

interface FileMeta {
    version: number;
    width: number;
    height: number;
    bitDepth: number;
    minimumETo: number;
    scalingFactor: number;
    origin: {
        x: number;
        y: number;
    };
}

readFileHeader().then( ( fileMeta ) => {
	FILE_META = fileMeta;
	console.log( "DEBUG: Loaded baseline ETo data." );
} ).catch( ( err ) => {
	console.error( "ERROR: An error occurred while reading the annual ETo data file header. Baseline ETo endpoint will be unavailable.", err );
} );

export const getBaselineETo = async function( req: express.Request, res: express.Response ) {
    console.log("DEBUG: getBaselineETo called with query:", req.query);
	const locationQueryParam = req.query.loc;
	const location: string	= getParameter( locationQueryParam as string | string[] | undefined );

	if ( !FILE_META ) {
		console.error("DEBUG: getBaselineETo - FILE_META not loaded.");
		res.status(503).send( "Baseline ETo calculation is currently unavailable (ETo data file not loaded)." );
		return;
	}

	let coordinates: GeoCoordinates;
	try {
		coordinates = await resolveCoordinates( location );
	} catch (err) {
        console.error("DEBUG: getBaselineETo - Error resolving coordinates:", err);
        const errorMessage = (err instanceof Error) ? err.message : String(err);
		res.status(404).send( `Error: Unable to resolve coordinates for location (${errorMessage})` );
		return;
	}

	let eto: number;
	try {
		eto = await calculateAverageDailyETo( coordinates );
	} catch ( err ) {
        console.error("DEBUG: getBaselineETo - Error calculating average daily ETo:", err);
		const statusCode = (err && typeof err === 'object' && 'code' in err) ? (err as any).code : 500;
        const message = (err && typeof err === 'object' && 'message' in err) ? (err as any).message : String(err);
		res.status(statusCode).send( message );
		return;
	}

	console.log("DEBUG: getBaselineETo - Successfully calculated ETo:", eto);
	res.status(200).json( {
		eto: Math.round( eto * 1000 ) / 1000
	} );
};

/**
 * The annual-average daily reference ETo (inches/day) for a location, from the
 * shipped baseline ETo data file. Throws { message, code } if the data file is
 * unavailable or the location is out of bounds. Used by the WaterBudget method
 * as the "normal day" reference.
 */
export async function getBaselineDailyETo( coordinates: GeoCoordinates ): Promise< number > {
	return calculateAverageDailyETo( coordinates );
}

async function calculateAverageDailyETo( coordinates: GeoCoordinates ): Promise< number > {
	if (!FILE_META) {
        console.error("DEBUG: calculateAverageDailyETo - FILE_META not loaded.");
        throw { message: "Baseline ETo data not loaded.", code: 503 };
    }
	const x = Math.floor( FILE_META.origin.x + FILE_META.width * coordinates[ 1 ] / 360 );
	const y = Math.floor( FILE_META.origin.y - FILE_META.height * coordinates[ 0 ] / ( 180 - 30 - 10 ) ); // Corrected for 140 degrees span
	const offset = y * FILE_META.width + x;

	if ( offset < 0 || offset >= (FILE_META.width * FILE_META.height) ) {
		throw { message: "Specified location is out of bounds.", code: 404 };
	}

	let byteValue: number; // Renamed from byte to avoid conflict
	try {
		byteValue = await getByteAtOffset( offset + 32 ); // Skip 32-byte header
	} catch ( err ) {
		console.error( `An error occurred while reading the baseline ETo data file for coordinates ${ coordinates }:`, err );
		throw { message: "An unexpected error occurred while retrieving the baseline ETo for this location.", code: 500 };
	}

	if ( ( byteValue === ( (1 << FILE_META.bitDepth) - 1 ) ) ) { // Max value for bit depth (e.g., 255 for 8-bit)
		throw { message: "ETo data is not available for this location (pixel is fill value).", code: 404 };
	}

	return ( byteValue * FILE_META.scalingFactor + FILE_META.minimumETo ) / 365;
}

function getByteAtOffset( offset: number ): Promise< number > {
	return new Promise< number >( ( resolve, reject ) => {
		const stream = fs.createReadStream( DATA_FILE, { start: offset, end: offset } ); // Read exactly one byte
		let receivedData = false;
		stream.on( "error", ( err ) => {
            if (!receivedData) reject( err ); // Avoid rejecting if data was already processed
		} );
		stream.on( "data", ( dataChunk: Buffer | string ) => {
            receivedData = true;
            if (Buffer.isBuffer(dataChunk) && dataChunk.length > 0) {
			    resolve( dataChunk[0] );
            } else if (typeof dataChunk === 'string' && dataChunk.length > 0) {
                // This case should ideally not happen for a binary file read of 1 byte
                resolve(dataChunk.charCodeAt(0));
            } else {
                reject(new Error("Stream did not return valid data for byte at offset " + offset));
            }
            stream.destroy(); // Close stream after getting the byte
		} );
        stream.on("end", () => {
            if (!receivedData) { // If stream ended without data (e.g. offset out of bounds)
                reject(new Error("No data found at offset " + offset + ". Stream ended."));
            }
        });
	} );
}

function readFileHeader(): Promise< FileMeta > {
	return new Promise< FileMeta >( ( resolve, reject) => {
		const stream = fs.createReadStream( DATA_FILE, { start: 0, end: 31 } ); // Read 32 bytes (0-31)
		const headerChunks: Buffer[] = [];

		stream.on( "error", ( err ) => {
			reject( err );
		} );
		stream.on( "data", ( dataChunk: Buffer ) => { // Expecting Buffer for binary read
			headerChunks.push( dataChunk );
		} );
		stream.on( "end", () => {
            const headerBuffer = Buffer.concat(headerChunks);
            if (headerBuffer.length < 32) {
                reject(new Error("Failed to read complete header from ETo data file. Read only " + headerBuffer.length + " bytes."));
                return;
            }

			const version = headerBuffer.readUInt8( 0 );
			if ( version !== 1 ) {
				reject( `Unsupported data file version ${ version }. The maximum supported version is 1.` );
				return;
			}

			const width = headerBuffer.readUInt32BE( 1 );
			const height = headerBuffer.readUInt32BE( 5 );
			const fileMetaResult: FileMeta = { // Renamed to avoid conflict with outer FILE_META
				version: version,
				width: width,
				height: height,
				bitDepth: headerBuffer.readUInt8( 9 ),
				minimumETo: headerBuffer.readFloatBE( 10 ),
				scalingFactor: headerBuffer.readFloatBE( 14 ),
				origin: {
					x: Math.floor( width / 2 ),
					y: Math.floor( height / ( 180 - 10 - 30) * ( 90 - 10 ) )
				}
			};

			if ( fileMetaResult.bitDepth === 8 ) {
				resolve( fileMetaResult );
			} else {
				reject( "Bit depths other than 8 are not currently supported." );
			}
		} );
	} );
}