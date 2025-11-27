// src/api.js
// Prefer same-origin by default. If someone accidentally builds with localhost,
// auto-correct to same-origin in production.
const configuredBase = (import.meta.env && import.meta.env.VITE_API_BASE) || "";
const isBrowser = typeof window !== "undefined";
const looksLikeLocalhost = (u) => typeof u === "string" && u.startsWith("http://localhost:");
const API_BASE = (isBrowser && looksLikeLocalhost(configuredBase)) ? "" : configuredBase;

async function http(method, url, body) {
  const res = await fetch(`${API_BASE}${url}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `${method} ${url} failed`);
  }
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : res.text();
}

export const api = {
  getState: () => http("GET", "/state"),
  listPurchases: () => http("GET", "/purchases"),
  addBalanceEntry: (e) => http("POST", "/balance/entries", e),
  updateBalanceEntry: (id, o) => http("PUT", `/balance/entries/${id}`, o),
  deleteBalanceEntry: (id) => http("DELETE", `/balance/entries/${id}`),
  addPartClass: (o) => http("POST", "/parts/classes", o),
  updatePartClass: (id, o) => http("PUT", `/parts/classes/${id}`, o),
  deletePartClass: (id) => http("DELETE", `/parts/classes/${id}`),
  addPartType: (o) => http("POST", "/parts/types", o),
  updatePartType: (id, o) => http("PUT", `/parts/types/${id}`, o),
  deletePartType: (id) => http("DELETE", `/parts/types/${id}`),
  addPurchase: (o) => http("POST", "/purchases", o),
  markDelivered: (id) => http("POST", `/purchases/${id}/mark-delivered`),
  addAdditionalCost: (id, o) => http("POST", `/purchases/${id}/add-cost`, o),
  toggleService: (id, isService) => http("POST", `/purchases/${id}/toggle-service`, { isService }),
  updatePurchase: (id, o) => http("PUT", `/purchases/${id}`, o),
  deletePurchase: (id) => http("DELETE", `/purchases/${id}`),
  listArchivedPurchases: () => http("GET", "/purchases/archived"),
  setPurchaseArchived: (id, archived) => http("POST", `/purchases/${id}/archive`, { archived }),
  addProduct: (o) => http("POST", "/products", o),
  updateProduct: (id, o) => http("PUT", `/products/${id}`, o),
  deleteProduct: (id) => http("DELETE", `/products/${id}`),
  assemble: (o) => http("POST", "/assembly", o),
  // Two-step assembly
  assemblyStart: (o) => http("POST", "/assembly/start", o),
  completeAssembly: (id) => http("POST", `/assemblies/${id}/complete`),
  sale: (o) => http("POST", "/sales", o),
  paySale: (id) => http("POST", `/sales/${id}/pay`),
  unpaySale: (id) => http("POST", `/sales/${id}/unpay`),
  allocateSale: (id) => http("POST", `/sales/${id}/allocate`),
  unallocateSale: (id) => http("POST", `/sales/${id}/unallocate`),
  shipSale: (id) => http("POST", `/sales/${id}/ship`),
  unshipSale: (id) => http("POST", `/sales/${id}/unship`),
  completeSale: (id) => http("POST", `/sales/${id}/complete`),
  uncompleteSale: (id) => http("POST", `/sales/${id}/uncomplete`),
  listArchivedSales: () => http("GET", "/sales/archived"),
  setSaleArchived: (id, archived) => http("POST", `/sales/${id}/archive`, { archived }),
  updateSale: (id, o) => http("PUT", `/sales/${id}`, o),
  deleteSale: (id) => http("DELETE", `/sales/${id}`),
  rebuild: () => http("POST", "/maintenance/rebuild"),
  fixPurchaseTotals: () => http("POST", "/maintenance/fix-purchase-totals"),
  // Manual stock ops + log
  writeoff: (o) => http("POST", "/stock/writeoff", o),
  replenish: (o) => http("POST", "/stock/replenish", o),
  stockLog: (page=1, pageSize=10) => http("GET", `/stock/log?page=${page}&page_size=${pageSize}`),
  // Suppliers
  listSuppliers: () => http("GET", "/suppliers"),
  addSupplier: (o) => http("POST", "/suppliers", o),
  updateSupplier: (id, o) => http("PUT", `/suppliers/${id}`, o),
  deleteSupplier: (id) => http("DELETE", `/suppliers/${id}`),
  // Settings
  getInventoryFilters: () => http("GET", "/settings/inventory-filters"),
  setInventoryFilters: (o) => http("POST", "/settings/inventory-filters", o),
  getBalanceRules: () => http("GET", "/settings/balance-rules"),
  setBalanceRules: (o) => http("POST", "/settings/balance-rules", o),
  getInventoryRules: () => http("GET", "/settings/inventory-rules"),
  setInventoryRules: (o) => http("POST", "/settings/inventory-rules", o),
  // Inventory avgCost update
  updateInventoryAvgCost: (partTypeId, avgCost) => http("PUT", `/inventory/${partTypeId}/avg-cost`, { avgCost }),
  // Customers
  listCustomers: () => http("GET", "/customers"),
  addCustomer: (o) => http("POST", "/customers", o),
  updateCustomer: (id, o) => http("PUT", `/customers/${id}`, o),
  deleteCustomer: (id) => http("DELETE", `/customers/${id}`),
  customersSummary: () => http("GET", "/customers/summary"),
};

export default api;
