## 10.0.0 - 2022-08-02

Major version release for API version 2022-08-01. Default API version changed to "2022-08-01".

Breaking changes that arose during code generation of the library that we postponed for the next major version. For changes to the SDK, read more detailed description at https://github.com/stripe/stripe-node/wiki/Migration-guide-for-v10. For changes to the Stripe products, read more at https://stripe.com/docs/upgrades#2022-08-01.

"⚠️" symbol highlights breaking changes.

* [#1497](https://github.com/stripe/stripe-node/pull/1497) API Updates
* [#1493](https://github.com/stripe/stripe-node/pull/1493) Next major release changes

### Added
* Add support for new value `invalid_tos_acceptance` on enums `Account.future_requirements.errors[].code`, `Account.requirements.errors[].code`, `Capability.future_requirements.errors[].code`, `Capability.requirements.errors[].code`, `Person.future_requirements.errors[].code`, and `Person.requirements.errors[].code`
* Add support for `shipping_cost` and `shipping_details` on `Checkout.Session`

### ⚠️ Changed
* Change type of `business_profile`, `business_type`, `country`, `default_currency`, and `settings` properties on `Account` resource to be nullable.
* Change type of `currency` property on `Checkout.Session` resource from `string` to `'cad' | 'usd'`.
* Change location of TypeScript definitions for `CreditNoteLineItemListPreviewParams`, `CreditNoteLineItemListPreviewParams.Line`, `CreditNoteLineItemListPreviewParams.Line.Type`, and `CreditNoteLineItemListPreviewParams.Line.Reason` interfaces from `CreditNoteLineItems.d.ts` to `CreditNotes.d.ts`.
* Change type of `address`, `currency`, `delinquent`, `discount`, `invoice_prefix`, `name`, `phone`, and `preferred_locales` properties on `Customer` resource to be nullable.
* Rename `InvoiceRetrieveUpcomingParams` to `InvoiceListUpcomingLinesParams`.

### ⚠️ Removed
* Remove for `AlipayAccount`, `DeletedAlipayAccount`, `BitcoinReceiver`, `DeletedBitcoinReceiver`, `BitcoinTransaction`, and `BitcoinTransactionListParams` definitions.
* Remove `AlipayAccount` and `BitcoinReceiver` from `CustomerSource`.
* Remove `Stripe.DeletedAlipayAccount` and `Stripe.DeletedBitcoinReceiver` from possible values of `source` property in `PaymentIntent`.
* Remove `IssuerFraudRecord`, `IssuerFraudRecordRetrieveParams`, `IssuerFraudRecordListParams`, and `IssuerFraudRecordsResource`, definitions.
* Remove `treasury.received_credit.reversed` webhook event constant. Please use `treasury.received_credit.returned` instead.
* Remove `order.payment_failed`, `transfer.failed`, and `transfer.paid`. The events were deprecated.
* Remove `retrieveDetails` method from `Issuing.Card` resource. The method was unsupported. Read more at https://stripe.com/docs/issuing/cards/virtual.
* Remove `Issuing.CardDetails` and `CardRetrieveDetailsParams` definition.
* Remove `IssuerFraudRecords` resource.
* Remove `Recipient` resource and`recipient` property from `Card` resource.
* Remove `InvoiceMarkUncollectibleParams` definition.
* Remove deprecated `Stripe.Errors` and `StripeError` (and derived `StripeCardError`, `StripeInvalidRequestError`, `StripeAPIError`, `StripeAuthenticationError`,  `StripePermissionError`, `StripeRateLimitError`, `StripeConnectionError`, `StripeSignatureVerificationError`, `StripeIdempotencyError`, and `StripeInvalidGrantError`)  definitions.
* Remove `redirect_url` from `LoginLinks` definition. The property is no longer supported.
* Remove `LineItemListParams` definition. The interface was no longer in use.

### ⚠️ Renamed
* Rename `listUpcomingLineItems` method on `Invoice` resource to `listUpcomingLines`.
* Rename `InvoiceLineItemListUpcomingParams` to `InvoiceListUpcomingLinesParams`.
* Rename `InvoiceRetrieveUpcomingParams` to `InvoiceListUpcomingLinesParams`.
