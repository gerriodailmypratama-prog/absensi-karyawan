-- PR-CL113: foto KTP dari iPhone tersimpan HEIC; bucket menolaknya. Izinkan HEIC/HEIF di ketiga bucket.
update storage.buckets
   set allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
 where id in ('absensi-selfie', 'absensi-profil', 'absensi-ktp');
