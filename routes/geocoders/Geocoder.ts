// routes/geocoders/Geocoder.ts
import fs = require("fs");
import { GeoCoordinates } from "../../types";
import { CodedError, ErrorCode } from "../../errors";

export abstract class Geocoder {
    private static cacheFile: string = __dirname + "/../../../geocoderCache.json";
    private cache: Map<string, GeoCoordinates | null>; // Allow null for "no result found"

    public constructor() {
        this.cache = new Map(); // Initialize with an empty map first
        if (fs.existsSync(Geocoder.cacheFile)) {
            try {
                const fileContent = fs.readFileSync(Geocoder.cacheFile, "utf-8");
                if (fileContent.trim() !== "") { // Only parse if not empty
                    const parsedCache = JSON.parse(fileContent);
                    if (Array.isArray(parsedCache)) { // Ensure it's an array for Map constructor
                        this.cache = new Map(parsedCache);
                        console.log("DEBUG Geocoder: Loaded cache from", Geocoder.cacheFile, "with", this.cache.size, "entries.");
                    } else {
                        console.warn("WARN Geocoder: Cache file content is not an array. Initializing empty cache.");
                    }
                } else {
                    console.log("DEBUG Geocoder: Cache file is empty. Initializing empty cache.");
                }
            } catch (err) {
                console.error("Error reading or parsing geocoderCache.json. Initializing empty cache.", err);
                this.cache = new Map(); // Fallback to empty cache on error
            }
        } else {
            console.log("DEBUG Geocoder: geocoderCache.json not found. Initializing empty cache.");
        }

        // Write the cache to disk every 5 minutes.
        const saveInterval = 5 * 60 * 1000;
        console.log(`DEBUG Geocoder: Will save cache every ${saveInterval / 60000} minutes.`);
        setInterval(() => {
            this.saveCache();
        }, saveInterval);
    }

    private saveCache(): void {
        try {
            fs.writeFileSync(Geocoder.cacheFile, JSON.stringify(Array.from(this.cache.entries())), "utf-8");
            console.log("DEBUG Geocoder: Successfully saved geocoder cache to disk.");
        } catch (err) {
            console.error("Error saving geocoder cache to disk:", err);
        }
    }

    protected abstract geocodeLocation(location: string): Promise<GeoCoordinates>;

    public async getLocation(location: string): Promise<GeoCoordinates> {
        const normalizedLocation = location.toLowerCase().trim(); // Normalize for consistent caching
        if (this.cache.has(normalizedLocation)) {
            const coords = this.cache.get(normalizedLocation);
            if (coords === null) { // Explicitly null means "no results found" and is cached
                console.log("DEBUG Geocoder: Cache hit (no results found) for:", normalizedLocation);
                throw new CodedError(ErrorCode.NoLocationFound);
            }
            console.log("DEBUG Geocoder: Cache hit for:", normalizedLocation, "Coords:", coords);
            return coords as GeoCoordinates; // We know it's not null here
        }

        console.log("DEBUG Geocoder: Cache miss for:", normalizedLocation, ". Calling geocodeLocation.");
        try {
            const coords = await this.geocodeLocation(normalizedLocation); // Use normalized
            this.cache.set(normalizedLocation, coords);
            // No need to call saveCache() here immediately, setInterval handles it
            return coords;
        } catch (ex) {
            if (ex instanceof CodedError && ex.errCode === ErrorCode.NoLocationFound) {
                console.log("DEBUG Geocoder: No location found for", normalizedLocation, "- caching this negative result.");
                this.cache.set(normalizedLocation, null); // Cache "no result" as null
            }
            throw ex; // Re-throw the original error
        }
    }
}