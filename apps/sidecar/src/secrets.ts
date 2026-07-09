import { Entry } from "@napi-rs/keyring";

/** 测试缝：集成测试用内存实现，真机用系统 Keychain */
export interface SecretStore {
  set(ref: string, secret: string): void;
  get(ref: string): string | null;
  delete(ref: string): void;
}

const SERVICE = "dev.haosen.socrates";

export class KeychainSecrets implements SecretStore {
  set(ref: string, secret: string): void {
    new Entry(SERVICE, ref).setPassword(secret);
  }
  get(ref: string): string | null {
    return new Entry(SERVICE, ref).getPassword();
  }
  delete(ref: string): void {
    new Entry(SERVICE, ref).deletePassword();
  }
}

export class MemorySecrets implements SecretStore {
  private map = new Map<string, string>();
  set(ref: string, secret: string): void {
    this.map.set(ref, secret);
  }
  get(ref: string): string | null {
    return this.map.get(ref) ?? null;
  }
  delete(ref: string): void {
    this.map.delete(ref);
  }
}
