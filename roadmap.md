# Roadmap

- [x] Copy GitHub project files + install deps
- [x] Fix preview/build errors
- [ ] Fix "الاسم لم يطابق أي منتج في الكتالوج" leak: fuzzy/token-based product matching in src/lib/order-availability.ts
- [ ] Fuzzy color/size matching (stop exact-equality "غير متاح" false negatives)
- [ ] pickProduct in order-catalog-match.ts must resolve ambiguity instead of returning null (silent no stock deduction)
- [ ] Remove regex/keyword dependence in payment-confirmation detection -> LLM-driven intent
