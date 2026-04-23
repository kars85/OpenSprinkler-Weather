import { expect } from "chai";

import LocalWeatherProvider, { captureWUStream, resetLocalWeatherStateForTests } from "./local";

describe("Local weather provider WU stream capture", () => {
	beforeEach(() => {
		resetLocalWeatherStateForTests();
	});

	it("does not emit NaN precipitation for the first observation", async () => {
		const request = {
			query: {
				dateutc: "2024-01-01 00:00:00",
				tempf: "70.0",
				humidity: "50",
				windspeedmph: "5.0",
				solarradiation: "500",
				dailyrainin: "0.12",
				rainin: "0.12"
			}
		};
		const response = { send: () => undefined };

		await captureWUStream(request as any, response as any);

		const provider = new LocalWeatherProvider();
		const weather = await provider.getWeatherData([42, -72]);
		expect(weather.value.precip).to.equal(0);
	});

	it("converts average solar radiation from W/m^2 to daily kWh/m^2", async () => {
		const request = {
			query: {
				dateutc: "2024-01-01 12:00:00",
				tempf: "70.0",
				humidity: "50",
				windspeedmph: "5.0",
				solarradiation: "1000",
				dailyrainin: "0",
				rainin: "0"
			}
		};
		const response = { send: () => undefined };

		const start = new Date("2024-01-01T12:00:00Z").getTime();
		for (let i = 0; i < 24; i++) {
			request.query.dateutc = new Date(start + i * 60 * 60 * 1000).toISOString().replace("T", " ").replace(".000Z", "");
			await captureWUStream(request as any, response as any);
		}

		const provider = new LocalWeatherProvider();
		const watering = await provider.getWateringData([42, -72]);
		expect(watering.value[0].solarRadiation).to.be.closeTo(24, 0.001);
	});
});
