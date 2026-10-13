import { dashboardAPI } from "./api";

const BULK_HOST_PAGE_SIZE = 500;
const SELECTED_HOST_BATCH_SIZE = 200;

// Do not silently turn "all hosts" into a single API page. Reject a changing
// fleet rather than patching an incomplete or duplicated selection.
export async function fetchAllMatchingHosts(params = {}) {
	const hosts = [];
	const seen = new Set();
	let total;
	do {
		const { data } = await dashboardAPI.getHosts({
			...params,
			limit: BULK_HOST_PAGE_SIZE,
			offset: hosts.length,
		});
		if (
			!Array.isArray(data?.items) ||
			!Number.isInteger(data.total) ||
			data.total < 0 ||
			(total !== undefined && total !== data.total) ||
			(data.items.length === 0 && hosts.length < data.total)
		) {
			throw new Error(
				"The host list changed or could not be loaded. Refresh and try again.",
			);
		}
		total = data.total;
		for (const host of data.items) {
			if (!host.id || seen.has(host.id)) {
				throw new Error("The host list changed. Refresh and try again.");
			}
			seen.add(host.id);
			hosts.push(host);
		}
	} while (hosts.length < total);
	if (hosts.length !== total) {
		throw new Error("The host list changed. Refresh and try again.");
	}
	return hosts;
}

export async function fetchSelectedHosts(hostIds) {
	const ids = [...new Set(hostIds)];
	const byId = new Map();
	for (let i = 0; i < ids.length; i += SELECTED_HOST_BATCH_SIZE) {
		const batch = ids.slice(i, i + SELECTED_HOST_BATCH_SIZE);
		const hosts = await fetchAllMatchingHosts({
			filter: "selected",
			selected: batch.join(","),
			sort: "hostname",
			order: "asc",
		});
		for (const host of hosts) byId.set(host.id, host);
	}
	if (ids.some((id) => !byId.has(id))) {
		throw new Error(
			"Some selected hosts are no longer available. Clear the selection and select hosts again.",
		);
	}
	return ids.map((id) => byId.get(id));
}
