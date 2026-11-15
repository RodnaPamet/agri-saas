# ZarnoBorsa parser fixtures

**SYNTHETIC. Every price and change is a made-up number.** The markup, the class names, the
whitespace, the `?p=graph&m=…&j=…` ids and the row DATES are real, captured logged-in on
2026-11-15 by the agrent-ios session with a single headless read.

**Never commit a raw capture.** This repository is public, and ZarnoBorsa's prices are a paid
product — a real capture here would republish them. The split is deliberate: the markup is what a
parser must survive and is ours to test against, the numbers are the source's and stay theirs. The
page's greeting carried the owner's full name and is stripped; there are no cookies and no email in
these files.

Non-Bulgarian regions are trimmed to two rows each; every Bulgarian row is kept. The real pages
carry more.

See #3081 for the id tables and the parse details these fixtures pin.
