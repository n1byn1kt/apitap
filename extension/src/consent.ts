const STORAGE_KEY = 'approvedAgentDomains';

function getStorage(): Promise<string[]> {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY], (result) => {
      resolve(result[STORAGE_KEY] ?? []);
    });
  });
}

function setStorage(domains: string[]): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY]: domains }, resolve);
  });
}

export async function isApproved(domain: string): Promise<boolean> {
  const domains = await getStorage();
  return domains.includes(domain);
}

export async function addApprovedDomain(domain: string): Promise<void> {
  const domains = await getStorage();
  if (!domains.includes(domain)) {
    domains.push(domain);
    await setStorage(domains);
  }
}

export async function removeApprovedDomain(domain: string): Promise<void> {
  const domains = await getStorage();
  await setStorage(domains.filter(d => d !== domain));
}

export async function getApprovedDomains(): Promise<string[]> {
  return getStorage();
}
