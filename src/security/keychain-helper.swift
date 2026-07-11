import Foundation
import Security

private enum Operation: String {
    case put
    case get
    case delete
}

private func fail(_ message: String, code: Int32 = 1) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(code)
}

guard CommandLine.arguments.count == 4,
      let operation = Operation(rawValue: CommandLine.arguments[1]) else {
    fail("invalid invocation")
}

let service = CommandLine.arguments[2]
let account = CommandLine.arguments[3]
let baseQuery: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service,
    kSecAttrAccount as String: account,
]

switch operation {
case .put:
    let value = FileHandle.standardInput.readDataToEndOfFile()
    guard !value.isEmpty else { fail("empty input") }
    let updateStatus = SecItemUpdate(
        baseQuery as CFDictionary,
        [kSecValueData as String: value] as CFDictionary
    )
    if updateStatus == errSecItemNotFound {
        var item = baseQuery
        item[kSecValueData as String] = value
        let addStatus = SecItemAdd(item as CFDictionary, nil)
        guard addStatus == errSecSuccess else { fail("keychain write failed") }
    } else if updateStatus != errSecSuccess {
        fail("keychain write failed")
    }

case .get:
    var query = baseQuery
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { fail("not found", code: 44) }
    guard status == errSecSuccess, let value = result as? Data else {
        fail("keychain read failed", code: 45)
    }
    FileHandle.standardOutput.write(value)

case .delete:
    let status = SecItemDelete(baseQuery as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
        fail("keychain delete failed")
    }
}
