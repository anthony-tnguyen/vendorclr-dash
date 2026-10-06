alter table public.vendors drop constraint vendors_trade_check;
alter table public.vendors add constraint vendors_trade_check
  check (trade = any (array['Structural Steel','Electrical','Mechanical / HVAC','Concrete','Earthwork','Roofing','Glazing','Fire Protection','Other']));

alter table public.project_vendor_assignments drop constraint project_vendor_assignments_trade_code_check;
alter table public.project_vendor_assignments add constraint project_vendor_assignments_trade_code_check
  check (trade_code = any (array['Structural Steel','Electrical','Mechanical / HVAC','Concrete','Earthwork','Roofing','Glazing','Fire Protection','Other']));
