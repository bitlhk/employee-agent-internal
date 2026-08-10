type JsonObject = Record<string, unknown>;

export type WealthMaturityRequest = {
  windowDays: number;
  maxCustomers: number;
  maxItems: number;
};

export type WealthMaturityItem = {
  customerId: string;
  customerName: string;
  riskLevel: string;
  assessmentStatus: string;
  assessmentExpiresAt: string | null;
  productId: string;
  productName: string;
  maturityDate: string;
  amount: number | null;
  status: string;
  daysUntilMaturity: number;
  priority: "high" | "medium" | "low";
  priorityReasons: string[];
  followupBy: string;
  lastContactAt: string | null;
  dataAsOf: string;
};

export type WealthMaturityContextResult = {
  schema: "ea.wealth-maturity-context.v1";
  status: "ready" | "no_upcoming_maturities" | "partial" | "unavailable";
  window: { from: string; to: string; days: number };
  summary: {
    customersScanned: number;
    customersFailed: number;
    matchingItems: number;
    returnedItems: number;
    truncated: boolean;
  };
  items: WealthMaturityItem[];
  guidance: {
    productRecommendationAllowed: false;
    writeRequiresSeparateConfirmation: true;
    message: string;
  };
  evidence: {
    sourceTools: ["wealth_assistant_customer_list", "wealth_assistant_customer_detail"];
    scope: "current-user-authorized-customers";
    dataAsOf: string[];
    generatedAt: string;
  };
};

export type WealthMaturityDependencies = {
  listCustomers(input: { page: number; pageSize: number }): Promise<JsonObject>;
  loadCustomer(customerId: string): Promise<JsonObject>;
};

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

function finiteNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function rowsFrom(payload: JsonObject, keys: string[]): JsonObject[] {
  const data = object(payload.data);
  for (const key of keys) {
    const value = payload[key] ?? data[key];
    if (Array.isArray(value)) return value.map(object).filter((row) => Object.keys(row).length > 0);
  }
  if (Array.isArray(payload.data)) return payload.data.map(object).filter((row) => Object.keys(row).length > 0);
  return [];
}

export function normalizeWealthCustomerList(payload: JsonObject): Array<{ customerId: string; customerName: string }> {
  return rowsFrom(payload, ["customers", "items", "rows", "list", "records"])
    .map((customer) => ({
      customerId: firstString(customer.customerId, customer.customer_id, customer.id, customer.customerCode, customer.customer_code),
      customerName: firstString(customer.name, customer.customerName, customer.customer_name),
    }))
    .filter((customer) => customer.customerId)
    .filter((customer, index, rows) => rows.findIndex((item) => item.customerId === customer.customerId) === index);
}

function customerObject(payload: JsonObject): JsonObject {
  const data = object(payload.data);
  const nested = object(data.customer);
  if (Object.keys(nested).length) return nested;
  const direct = object(payload.customer);
  if (Object.keys(direct).length) return direct;
  return Object.keys(data).length ? data : payload;
}

function maturityRows(customer: JsonObject): JsonObject[] {
  const direct = [
    "expiringProducts", "expiring_products", "maturingProducts", "maturing_products",
    "dueProducts", "due_products", "upcomingMaturities", "upcoming_maturities",
    "maturityItems", "maturity_items",
  ];
  for (const key of direct) {
    const value = customer[key];
    if (Array.isArray(value)) return value.map(object).filter((row) => Object.keys(row).length > 0);
  }
  for (const key of ["holdings", "positions", "products", "assets"]) {
    const value = customer[key];
    if (!Array.isArray(value)) continue;
    return value.map(object).filter((row) => firstString(
      row.maturityDate, row.maturity_date, row.expireDate, row.expire_date,
      row.expiryDate, row.expiry_date, row.dueDate, row.due_date, row.endDate, row.end_date,
    ));
  }
  return [];
}

function validIso(value: unknown): string | null {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function priorityFor(days: number, amount: number | null, lastContactAt: string | null, now: Date) {
  const reasons: string[] = [];
  let rank = 3;
  if (days <= 7) {
    rank = 1;
    reasons.push("7 天内到期");
  } else if (days <= 14) {
    rank = 2;
    reasons.push("14 天内到期");
  }
  if (amount !== null && amount >= 1_000_000) {
    rank = 1;
    reasons.push("到期金额较高");
  } else if (amount !== null && amount >= 500_000) {
    rank = Math.min(rank, 2);
    reasons.push("到期金额需重点关注");
  }
  if (lastContactAt) {
    const ageDays = Math.floor((now.getTime() - Date.parse(lastContactAt)) / 86_400_000);
    if (Number.isFinite(ageDays) && ageDays >= 30) {
      rank = Math.min(rank, 2);
      reasons.push("距上次联系已超过 30 天");
    }
  }
  if (!reasons.length) reasons.push("处于本次到期经营时间窗");
  return { priority: (rank === 1 ? "high" : rank === 2 ? "medium" : "low") as WealthMaturityItem["priority"], reasons };
}

export function normalizeWealthMaturityItems(input: {
  payload: JsonObject;
  expectedCustomerId: string;
  fallbackCustomerName: string;
  from: Date;
  to: Date;
}): WealthMaturityItem[] {
  const customer = customerObject(input.payload);
  const customerId = firstString(customer.customerId, customer.customer_id, customer.id, input.expectedCustomerId);
  if (customerId !== input.expectedCustomerId) throw new Error("客户 MCP 返回的客户标识与授权清单不一致");
  const customerName = firstString(customer.name, customer.customerName, customer.customer_name, input.fallbackCustomerName);
  const assessment = object(customer.riskAssessment || customer.risk_assessment || customer.assessment);
  const assessmentExpiresAt = validIso(firstString(
    customer.assessmentExpiresAt, customer.assessment_expires_at,
    customer.riskAssessmentExpiresAt, customer.risk_assessment_expires_at,
    assessment.expiresAt, assessment.expires_at, assessment.validUntil,
  ));
  const assessmentStatus = firstString(
    customer.assessmentStatus, customer.assessment_status,
    customer.riskAssessmentStatus, customer.risk_assessment_status,
    assessment.status,
  );
  const lastContactAt = validIso(firstString(customer.lastContactAt, customer.last_contact_at, customer.lastInteractionAt, customer.last_interaction_at));
  const defaultDataAsOf = firstString(customer.dataAsOf, customer.data_as_of, customer.updatedAt, customer.updated_at, input.payload.updatedAt, input.payload.updated_at);
  return maturityRows(customer).flatMap((item) => {
    const maturityDate = validIso(firstString(
      item.maturityDate, item.maturity_date, item.expireDate, item.expire_date,
      item.expiryDate, item.expiry_date, item.dueDate, item.due_date, item.endDate, item.end_date,
    ));
    if (!maturityDate) return [];
    const maturityTimestamp = Date.parse(maturityDate);
    if (maturityTimestamp < input.from.getTime() || maturityTimestamp > input.to.getTime()) return [];
    const amount = finiteNumber(item.maturityAmount, item.maturity_amount, item.amount, item.principal, item.balance, item.marketValue, item.market_value);
    const dataAsOf = validIso(firstString(item.dataAsOf, item.data_as_of, item.updatedAt, item.updated_at, defaultDataAsOf));
    if (!dataAsOf) throw new Error("客户 MCP 未提供可验证的数据时间");
    const daysUntilMaturity = Math.max(0, Math.ceil((maturityTimestamp - input.from.getTime()) / 86_400_000));
    const priority = priorityFor(daysUntilMaturity, amount, lastContactAt, input.from);
    const followupLeadDays = daysUntilMaturity <= 7 ? 1 : 7;
    const followupBy = new Date(Math.max(input.from.getTime(), maturityTimestamp - followupLeadDays * 86_400_000)).toISOString();
    return [{
      customerId,
      customerName,
      riskLevel: firstString(customer.riskLevel, customer.risk_level, customer.riskRating, customer.risk_rating, assessment.level),
      assessmentStatus,
      assessmentExpiresAt,
      productId: firstString(item.productId, item.product_id, item.id, item.productCode, item.product_code),
      productName: firstString(item.name, item.productName, item.product_name),
      maturityDate,
      amount,
      status: firstString(item.status, item.productStatus, item.product_status),
      daysUntilMaturity,
      priority: priority.priority,
      priorityReasons: priority.reasons,
      followupBy,
      lastContactAt,
      dataAsOf,
    }];
  });
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, task: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = { status: "fulfilled", value: await task(items[index]) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }));
  return results;
}

export async function prepareWealthMaturityContext(input: {
  roleTemplate: string;
  request: WealthMaturityRequest;
  dependencies: WealthMaturityDependencies;
  now?: Date;
}): Promise<WealthMaturityContextResult> {
  if (input.roleTemplate !== "wealth-manager") throw new Error("当前岗位无权执行到期客户经营任务");
  const now = input.now || new Date();
  const to = new Date(now.getTime() + input.request.windowDays * 86_400_000);
  const listPayload = await input.dependencies.listCustomers({ page: 1, pageSize: input.request.maxCustomers });
  const customers = normalizeWealthCustomerList(listPayload).slice(0, input.request.maxCustomers);
  const details = await mapWithConcurrency(customers, 5, async (customer) => normalizeWealthMaturityItems({
    payload: await input.dependencies.loadCustomer(customer.customerId),
    expectedCustomerId: customer.customerId,
    fallbackCustomerName: customer.customerName,
    from: now,
    to,
  }));
  const failures = details.filter((result) => result.status === "rejected").length;
  const allItems = details.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  const priorityRank = { high: 1, medium: 2, low: 3 } as const;
  allItems.sort((left, right) => priorityRank[left.priority] - priorityRank[right.priority]
    || Date.parse(left.maturityDate) - Date.parse(right.maturityDate)
    || (right.amount || 0) - (left.amount || 0));
  const items = allItems.slice(0, input.request.maxItems);
  const status = customers.length > 0 && failures === customers.length
    ? "unavailable"
    : failures > 0
      ? "partial"
      : items.length
        ? "ready"
        : "no_upcoming_maturities";
  return {
    schema: "ea.wealth-maturity-context.v1",
    status,
    window: { from: now.toISOString(), to: to.toISOString(), days: input.request.windowDays },
    summary: {
      customersScanned: customers.length,
      customersFailed: failures,
      matchingItems: allItems.length,
      returnedItems: items.length,
      truncated: allItems.length > items.length || customers.length >= input.request.maxCustomers,
    },
    items,
    guidance: {
      productRecommendationAllowed: false,
      writeRequiresSeparateConfirmation: true,
      message: status === "unavailable"
        ? "客户详情服务暂时不可用，不能形成具体客户到期经营结论。"
        : "本结果只用于安排客户跟进；如需推荐产品，必须另行执行当前产品查询和适当性校验。创建跟进任务需单独确认。",
    },
    evidence: {
      sourceTools: ["wealth_assistant_customer_list", "wealth_assistant_customer_detail"],
      scope: "current-user-authorized-customers",
      dataAsOf: Array.from(new Set(items.map((item) => item.dataAsOf).filter(Boolean))),
      generatedAt: now.toISOString(),
    },
  };
}
