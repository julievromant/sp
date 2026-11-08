import { createClient } from '@supabase/supabase-js';

export async function onRequestPost(context) {
    const { request, env } = context;

    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
        return new Response(JSON.stringify({ 
            status: 'error', 
            message: 'Configuration serveur incomplète : SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY manquant.' 
        }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    try {
        const body = await request.json().catch(() => ({}));
        const { action, ...payload } = body;
        let result = { status: 'success' };

        const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

        switch (action) {
            case 'get_data': {
                const { data: events, error: evErr } = await supabase.from('events').select('*');
                if (evErr) console.error("Erreur lecture events:", evErr);
                
                const { data: users, error: usErr } = await supabase.from('users').select('*');
                if (usErr) console.error("Erreur lecture users:", usErr);

                const { data: registrations, error: regErr } = await supabase.from('registrations').select('*');
                if (regErr) console.error("Erreur lecture registrations:", regErr);

                // Associer les inscriptions de la table dédiée aux missions respectives
                const formattedEvents = (events || []).map(evt => {
                    const missions = (evt.missions || []).map(m => {
                        const mVolunteers = (registrations || [])
                            .filter(r => r.event_id === String(evt.id) && r.mission_id === String(m.id))
                            .map(r => ({ email: r.user_email, name: r.user_name }));
                        return { ...m, volunteers: mVolunteers };
                    });
                    return { ...evt, missions };
                });
                
                result = { events: formattedEvents, users: users || [] };
                break;
            }

            case 'toggle_signup': {
                const { eventId, missionId, email, name } = payload;
                const cleanEmail = (email || '').trim().toLowerCase();

                // Vérifier si l'inscription existe déjà
                const { data: existing } = await supabase
                    .from('registrations')
                    .select('id')
                    .eq('event_id', String(eventId))
                    .eq('mission_id', String(missionId))
                    .eq('user_email', cleanEmail)
                    .maybeSingle();

                if (existing) {
                    // Supprimer l'inscription
                    const { error } = await supabase
                        .from('registrations')
                        .delete()
                        .eq('id', existing.id);
                    if (error) throw new Error("Erreur annulation inscription: " + error.message);
                    result = { status: 'success', action: 'removed' };
                } else {
                    // Créer l'inscription
                    const { error } = await supabase
                        .from('registrations')
                        .insert([{
                            event_id: String(eventId),
                            mission_id: String(missionId),
                            user_email: cleanEmail,
                            user_name: name
                        }]);
                    if (error) throw new Error("Erreur validation inscription: " + error.message);
                    result = { status: 'success', action: 'added' };
                }
                break;
            }

            case 'save_event': {
                // Nettoyer les missions des bénévoles avant stockage dans la colonne jsonb si elle existe
                const cleanEvent = { ...payload.event };
                if (cleanEvent.missions) {
                    cleanEvent.missions = cleanEvent.missions.map(m => {
                        const { volunteers, ...rest } = m;
                        return rest;
                    });
                }
                const { error } = await supabase.from('events').upsert(cleanEvent);
                if (error) throw new Error("Erreur save_event: " + error.message);
                break;
            }

            case 'delete_event': {
                // Supprimer les inscriptions associées puis l'événement
                await supabase.from('registrations').delete().eq('event_id', String(payload.eventId));
                const { error } = await supabase.from('events').delete().eq('id', payload.eventId);
                if (error) throw new Error("Erreur delete_event: " + error.message);
                break;
            }

            case 'check_email': {
                const email = (payload.email || '').trim().toLowerCase();
                const { data, error } = await supabase.from('users').select('email').eq('email', email).maybeSingle();
                if (error) console.error("Erreur check_email:", error);
                result = { exists: !!data };
                break;
            }

            case 'send_magic_link': {
                const email = (payload.email || '').trim().toLowerCase();
                const firstname = payload.firstname || 'Parent';
                const lastname = payload.lastname || 'Bénévole';
                const kidsClasses = payload.kidsClasses || 'CP';

                if (payload.isNew) {
                    await supabase.from('users').upsert({
                        email: email,
                        firstname: firstname,
                        lastname: lastname,
                        kids_classes: kidsClasses,
                        is_admin: email === 'marie.parent@apel.fr'
                    }, { onConflict: 'email' });
                }

                const redirectUrl = new URL(request.url).origin + '/';
                const { error } = await supabase.auth.signInWithOtp({
                    email: email,
                    options: {
                        emailRedirectTo: redirectUrl,
                        data: { firstname, lastname, kids_classes: kidsClasses }
                    }
                });

                if (error) throw new Error(error.message);
                result = { status: 'success', message: 'Lien magique envoyé avec succès.' };
                break;
            }

            case 'verify_magic_link': {
                const code = payload.code;
                const hash = payload.hash;

                if (!code && (!hash || !hash.includes('access_token'))) {
                    throw new Error("Paramètres d'authentification manquants.");
                }

                let authUser = null;

                if (code) {
                    const { data: sessionData, error: sessionError } = await supabase.auth.exchangeCodeForSession(code);
                    if (sessionError || !sessionData?.user) throw new Error(sessionError?.message || "Échec échange du code PKCE.");
                    authUser = sessionData.user;
                } else if (hash) {
                    const params = new URLSearchParams(hash.replace(/^#/, ''));
                    const accessToken = params.get('access_token');
                    if (accessToken) {
                        const { data: userData, error: userErr } = await supabase.auth.getUser(accessToken);
                        if (!userErr && userData) authUser = userData.user;
                    }
                }

                if (!authUser) throw new Error("Utilisateur introuvable.");

                const email = authUser.email.toLowerCase();
                const metadata = authUser.user_metadata || {};

                let { data: dbUser } = await supabase.from('users').select('*').eq('email', email).maybeSingle();

                if (!dbUser) {
                    const newUser = {
                        id: authUser.id,
                        email: email,
                        firstname: metadata.firstname || 'Parent',
                        lastname: metadata.lastname || 'Bénévole',
                        kids_classes: metadata.kids_classes || 'CP',
                        is_admin: email === 'marie.parent@apel.fr'
                    };
                    const { data: inserted, error: insertErr } = await supabase.from('users').insert([newUser]).select().single();
                    if (insertErr) throw new Error("Erreur création utilisateur: " + insertErr.message);
                    dbUser = inserted;
                }

                result = { status: 'success', user: dbUser };
                break;
            }

            default:
                throw new Error('Action inconnue: ' + action);
        }

        return new Response(JSON.stringify(result), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (error) {
        console.error("ERREUR PROXY:", error.message);
        return new Response(JSON.stringify({ 
            status: 'error', 
            message: error.message || 'Erreur interne du serveur' 
        }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}