class UnbundledSqliteDatabase {
  constructor() {
    throw new Error(
      "sqlite3 is not bundled in Sikong standalone binaries. Use JsonlLocalAgentStore instead.",
    );
  }
}

export const Database = UnbundledSqliteDatabase;

export default {
  Database,
};
