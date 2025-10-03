// src/api.js
const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8000";

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
  addPartClass: (o) => http("POST", "/parts/classes", o),
  addPartType: (o) => http("POST", "/parts/types", o),
  addPurchase: (o) => http("POST", "/purchases", o),
  markDelivered: (id) => http("POST", `/purchases/${id}/mark-delivered`),
  payFromBalance: (id) => http("POST", `/purchases/${id}/pay-from-balance`),
  addAdditionalCost: (id, o) => http("POST", `/purchases/${id}/add-cost`, o),
  toggleService: (id, isService) => http("POST", `/purchases/${id}/toggle-service`, { isService }),
  updatePurchase: (id, o) => http("PUT", `/purchases/${id}`, o),
  deletePurchase: (id) => http("DELETE", `/purchases/${id}`),
  addProduct: (o) => http("POST", "/products", o),
  assemble: (o) => http("POST", "/assembly", o),
  sale: (o) => http("POST", "/sales", o),
  rebuild: () => http("POST", "/maintenance/rebuild"),
  // Suppliers
  listSuppliers: () => http("GET", "/suppliers"),
  addSupplier: (o) => http("POST", "/suppliers", o),
  updateSupplier: (id, o) => http("PUT", `/suppliers/${id}`, o),
  deleteSupplier: (id) => http("DELETE", `/suppliers/${id}`),
};

export default api;
