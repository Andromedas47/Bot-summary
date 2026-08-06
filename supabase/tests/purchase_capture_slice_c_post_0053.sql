-- Disposable-DB only: reattach Slice A session.movement_id FK after 0053 replaces the stub.
ALTER TABLE public.purchase_capture_sessions
  ADD CONSTRAINT purchase_capture_sessions_movement_id_fkey
  FOREIGN KEY (movement_id) REFERENCES public.inventory_movements(id);
