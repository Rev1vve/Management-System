# OOXML compatibility fixtures

These small documents are copied from upstream public test-data repositories so the
attachment validator is exercised against files created by real office software,
not only synthetic ZIP builders.

| Local file                | Upstream source                                       | Producer metadata                                       | SHA-256                                                            | Reason                                                                                           |
| ------------------------- | ----------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `libreoffice-4.2.docx`    | Apache POI `test-data/document/56392.docx`            | `Application=LibreOffice/4.2.3.3...`                    | `bdff4457ccfbe7482f8230e2e1085e8becdda5bc869237923a4e70977d3b6678` | Every entry uses ZIP data-descriptor bit 3 and a signed 16-byte descriptor.                      |
| `libreoffice-5.0.xlsx`    | Apache POI `test-data/spreadsheet/59775.xlsx`         | `Application=LibreOffice/5.0.3.2...`                    | `8800024c3f42ecc1c4171d6c34e35fced0a3c82f10ad5939f01ba85579979871` | Every entry uses ZIP data-descriptor bit 3 and a signed 16-byte descriptor.                      |
| `microsoft-word-12.docx`  | Apache POI `test-data/document/52288.docx`            | `Application=Microsoft Office Word; AppVersion=12.0000` | `8ab0f0afddd11ab43bd2dcfe4e5b51f8a4dfcc948fe3f327b338bcc2c3733bee` | Real Microsoft Word producer metadata; entries use bounded local sizes without data descriptors. |
| `microsoft-excel-12.xlsx` | Apache POI `test-data/spreadsheet/123233_charts.xlsx` | `Application=Microsoft Excel; AppVersion=12.0000`       | `47e9e8dea87494d17dbacce9aa3a9ec31cb2b26b288de05ca95c0a4622ca7f80` | Real Microsoft Excel producer metadata; every entry uses bit 3 and a signed descriptor.          |

Upstream raw URLs:

- `https://raw.githubusercontent.com/apache/poi/trunk/test-data/document/56392.docx`
- `https://raw.githubusercontent.com/apache/poi/trunk/test-data/spreadsheet/59775.xlsx`
- `https://raw.githubusercontent.com/apache/poi/trunk/test-data/document/52288.docx`
- `https://raw.githubusercontent.com/apache/poi/trunk/test-data/spreadsheet/123233_charts.xlsx`

The fixtures remain attributed to the Apache POI upstream project and are retained only as small interoperability test inputs; consult that upstream repository for its license and test-data provenance.

The test verifies the hashes before upload so accidental or upstream fixture drift is
fail-closed. These files contain test data only and no project/business information.
