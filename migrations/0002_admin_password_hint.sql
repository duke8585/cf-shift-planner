-- Masked hint (first + last character, real length) shown after repeated wrong admin passwords.
ALTER TABLE plans ADD COLUMN admin_password_hint TEXT;
